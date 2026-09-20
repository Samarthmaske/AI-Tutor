
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ConnectionStatus, Message } from './types';
import { decode, encode, decodeAudioData, createPcmBlob } from './services/audioUtils';

// --- Constants ---
const FRAME_RATE = 0.5; // 1 frame every 2 seconds to reduce API load and speed up responses
const JPEG_QUALITY = 0.6;

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [micVolume, setMicVolume] = useState(0);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('English');

  // --- Refs for Resources ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const sessionRef = useRef<any>(null);
  
  // Audio Context Refs
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // VAD Refs
  const isSpeakingRef = useRef<boolean>(false);
  const silenceStartRef = useRef<number | null>(null);

  // --- Initialize Devices ---
  useEffect(() => {
    const getDevices = async () => {
      try {
        // Request initial permission to get device labels
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        setAudioDevices(audioInputs);
        if (audioInputs.length > 0) {
          setSelectedDeviceId(audioInputs[0].deviceId);
        }
      } catch (err) {
        console.error('Error getting devices:', err);
      }
    };
    getDevices();
  }, []);

  // --- Helpers ---
  const addMessage = (role: 'user' | 'model', text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: Date.now() }]);
  };

  const cleanup = useCallback(() => {
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {}
      sessionRef.current = null;
    }
    
    // Stop all audio output
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    
    setIsScreenSharing(false);
    setStatus(ConnectionStatus.DISCONNECTED);
  }, []);

  const handleStop = () => {
    cleanup();
  };

  const startScreenIntelligence = async () => {
    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);

      // Create and resume AudioContexts immediately in the user gesture!
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      if (inputCtx.state === 'suspended') inputCtx.resume();
      if (outputCtx.state === 'suspended') outputCtx.resume();

      // 1. Get User Media (Mic) with full echo cancellation and specific device
      const audioConstraints: any = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
      };
      if (selectedDeviceId) {
          audioConstraints.deviceId = { exact: selectedDeviceId };
      }
      
      const micStream = await navigator.mediaDevices.getUserMedia({ 
          audio: audioConstraints
      });
      micStreamRef.current = micStream;

      // 2. Get Screen Stream
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as any,
        audio: false,
      });
      streamRef.current = screenStream;
      setIsScreenSharing(true);

      // We need to wait for the next render for videoRef.current to be populated.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.play().catch(e => console.error('Video play error:', e));
        }
      }, 100);

      const outputNode = outputAudioCtxRef.current!.createGain();
      outputNode.connect(outputAudioCtxRef.current!.destination);

      // 4. Connect to Backend Relay
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = import.meta.env.PROD ? window.location.host : 'localhost:8080';
      const wsUrl = `${wsProtocol}//${wsHost}?lang=${encodeURIComponent(selectedLanguage)}`;
      const ws = new WebSocket(wsUrl);
      sessionRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket relay connected');
      };

      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        
        if (message.type === 'connected') {
            setStatus(ConnectionStatus.CONNECTED);
            
            // Start streaming mic audio
            if (inputAudioCtxRef.current) {
              if (inputAudioCtxRef.current.state === 'suspended') {
                  inputAudioCtxRef.current.resume();
              }
              const source = inputAudioCtxRef.current.createMediaStreamSource(micStream);
              const scriptProcessor = inputAudioCtxRef.current.createScriptProcessor(2048, 1, 1);
              scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Calculate volume for UI
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += Math.abs(inputData[i]);
                }
                const volume = sum / inputData.length;
                setMicVolume(volume);

                // Aggressive Client-Side VAD (Voice Activity Detection)
                if (volume > 0.01) {
                    silenceStartRef.current = null;
                    isSpeakingRef.current = true;
                } else if (isSpeakingRef.current) {
                    if (silenceStartRef.current === null) {
                        silenceStartRef.current = Date.now();
                    } else if (Date.now() - silenceStartRef.current > 800) {
                        // 800ms of silence detected! End turn immediately to bypass AI delay.
                        isSpeakingRef.current = false;
                        silenceStartRef.current = null;
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'end_of_turn' }));
                        }
                    }
                }

                const pcmBlob = createPcmBlob(inputData);
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ media: pcmBlob }));
                }
              };
              source.connect(scriptProcessor);
              scriptProcessor.connect(inputAudioCtxRef.current.destination);
            }

            // Start streaming screen frames
            frameIntervalRef.current = window.setInterval(() => {
              if (videoRef.current && canvasRef.current && ws.readyState === WebSocket.OPEN) {
                const video = videoRef.current;
                const canvas = canvasRef.current;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  const MAX_WIDTH = 854; // 480p width
                  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
                  canvas.width = video.videoWidth * scale;
                  canvas.height = video.videoHeight * scale;
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  canvas.toBlob(async (blob) => {
                    if (blob) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64Data = (reader.result as string).split(',')[1];
                        ws.send(JSON.stringify({
                          media: { data: base64Data, mimeType: 'image/jpeg' }
                        }));
                      };
                      reader.readAsDataURL(blob);
                    }
                  }, 'image/jpeg', JPEG_QUALITY);
                }
              }
            }, 1000 / FRAME_RATE);
            return;
        }

        if (message.error) {
            console.error('Relay error:', message.error);
            setError(message.error);
            cleanup();
            return;
        }

        // Handle Server Content (Audio & Text)
        const parts = message.serverContent?.modelTurn?.parts;
        if (parts) {
          // Extract Text
          const textPart = parts.find((p: any) => p.text);
          if (textPart && textPart.text) {
            addMessage('model', textPart.text);
          }

          // Extract Audio
          const audioPart = parts.find((p: any) => p.inlineData && p.inlineData.mimeType?.startsWith('audio'));
          const base64Audio = audioPart?.inlineData?.data;

          if (base64Audio && outputAudioCtxRef.current) {
            try {
              const ctx = outputAudioCtxRef.current;
              if (ctx.state === 'suspended') {
                  ctx.resume();
              }
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
              });
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            } catch (audioErr) {
              console.error('Audio playback error:', audioErr);
            }
          }
        }

        // Handle Interruptions: Stop current audio and reset timing so new responses play immediately
        if (message.serverContent?.interrupted) {
          console.log('Gemini interrupted by user audio');
          audioSourcesRef.current.forEach(source => {
            try { source.stop(); } catch (e) {}
          });
          audioSourcesRef.current.clear();
          nextStartTimeRef.current = 0;
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        setError('An error occurred with the relay connection.');
        cleanup();
      };

      ws.onclose = () => {
        console.log('WebSocket closed');
        cleanup();
      };

      // Handle screen sharing stop (from browser UI)
      screenStream.getVideoTracks()[0].onended = () => {
        cleanup();
      };

    } catch (err: any) {
      console.error('Error starting screen intelligence:', err);
      setError(err.message || 'Failed to start screen intelligence. Ensure you granted permissions.');
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const sendTextMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || status !== ConnectionStatus.CONNECTED || !sessionRef.current) return;
    
    // Add to UI
    addMessage('user', inputText);
    
    // Send to backend
    if (sessionRef.current.readyState === WebSocket.OPEN) {
      sessionRef.current.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: inputText }] }],
          turnComplete: true
        }
      }));
    }
    
    setInputText('');
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 bg-slate-900 text-white">
      {/* Header */}
      <div className="w-full max-w-6xl flex flex-col md:flex-row items-center justify-between mb-8 space-y-4 md:space-y-0">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Screen Intelligence</h1>
            <p className="text-slate-400 text-sm">Real-time AI Vision & Voice Assistant</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2 px-3 py-1.5 bg-slate-800 rounded-full border border-slate-700">
            <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
            <span className="text-xs font-medium text-slate-300 uppercase tracking-wider">{status}</span>
          </div>

          {!isScreenSharing ? (
            <button
              onClick={startScreenIntelligence}
              disabled={status === ConnectionStatus.CONNECTING}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:cursor-not-allowed transition-all rounded-full font-semibold flex items-center space-x-2 shadow-lg shadow-indigo-600/20"
            >
              <span>Share Screen & Talk</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="px-6 py-2.5 bg-red-600 hover:bg-red-500 transition-all rounded-full font-semibold flex items-center space-x-2 shadow-lg shadow-red-600/20"
            >
              <span>Stop Sharing</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1">
        
        {/* Screen Preview */}
        <div className="lg:col-span-3 bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden relative group">
          {isScreenSharing ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-contain bg-black"
              />
              <div className="absolute top-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg text-xs font-mono text-green-400 border border-green-500/30 opacity-0 group-hover:opacity-100 transition-opacity">
                LIVE FEED • {FRAME_RATE}FPS
              </div>
            </>
          ) : (
            <div className="w-full aspect-video flex flex-col items-center justify-center text-slate-500 space-y-4">
              <div className="w-16 h-16 bg-slate-700/30 rounded-full flex items-center justify-center border border-slate-700">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <p className="text-lg font-medium">Ready to analyze your screen</p>
              <p className="text-sm text-slate-600 max-w-xs text-center">
                Click "Share Screen" above to start the real-time AI session. Gemini will be able to see and talk about what's on your display.
              </p>
            </div>
          )}
          
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Info / Logs Side Panel */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl flex flex-col h-[500px] lg:h-auto">
          <div className="p-4 border-b border-slate-700 flex items-center justify-between">
            <h2 className="font-semibold flex items-center space-x-2">
              <svg className="w-4 h-4 text-indigo-400" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
              </svg>
              <span>Instructions</span>
            </h2>
          </div>
          
          <div className="flex-1 p-6 space-y-6 overflow-y-auto">
            <div className="space-y-4">
              {messages.length === 0 ? (
                <>
                  <div className="flex space-x-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">1</div>
                    <p className="text-sm text-slate-300">Grant microphone and screen recording permissions.</p>
                  </div>
                  <div className="flex space-x-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">2</div>
                    <p className="text-sm text-slate-300">Talk naturally. Gemini is listening and watching your active screen.</p>
                  </div>
                  <div className="flex space-x-3">
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold">3</div>
                    <p className="text-sm text-slate-300">Try asking: "What's on my screen?", "Can you help me summarize this?", or "Explain this code."</p>
                  </div>
                </>
              ) : (
                <div className="flex flex-col space-y-4">
                  {messages.map((msg, i) => (
                    <div key={i} className={`p-3 rounded-lg text-sm ${msg.role === 'model' ? 'bg-indigo-900/40 text-indigo-100 border border-indigo-500/30' : 'bg-slate-800 text-slate-300 border border-slate-700'}`}>
                      <div className="font-bold mb-1 text-xs uppercase tracking-wider opacity-70">
                        {msg.role === 'model' ? 'Gemini' : 'You'}
                      </div>
                      <div className="whitespace-pre-wrap">{msg.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/50 rounded-lg flex space-x-2 text-red-400 animate-in fade-in slide-in-from-bottom-2">
                <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <p className="text-xs font-medium">{error}</p>
              </div>
            )}

            {/* Microphone & Language Selectors */}
            {status !== ConnectionStatus.CONNECTED && (
                <div className="space-y-4">
                    {audioDevices.length > 0 && (
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Select Microphone</label>
                            <select 
                                value={selectedDeviceId}
                                onChange={(e) => setSelectedDeviceId(e.target.value)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-indigo-500"
                            >
                                {audioDevices.map((device, idx) => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {device.label || `Microphone ${idx + 1}`}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Language</label>
                        <select 
                            value={selectedLanguage}
                            onChange={(e) => setSelectedLanguage(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-indigo-500"
                        >
                            <option value="English">English</option>
                            <option value="Spanish">Spanish</option>
                            <option value="French">French</option>
                            <option value="German">German</option>
                            <option value="Hindi">Hindi</option>
                            <option value="Japanese">Japanese</option>
                            <option value="Mandarin">Mandarin</option>
                            <option value="Korean">Korean</option>
                            <option value="Arabic">Arabic</option>
                            <option value="Portuguese">Portuguese</option>
                            <option value="Russian">Russian</option>
                            <option value="Italian">Italian</option>
                        </select>
                    </div>
                </div>
            )}

            {status === ConnectionStatus.CONNECTED && (
               <div className="p-4 bg-indigo-600/10 border border-indigo-500/30 rounded-xl space-y-4">
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                    <span className="text-xs font-bold text-indigo-300 uppercase">Live Session Active</span>
                  </div>
                  <p className="text-xs text-slate-400">Gemini is processing your screen data and audio in real-time.</p>
                  
                  {/* Mic Volume Indicator */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-slate-400 font-medium">
                      <span>MIC VOLUME</span>
                      <span>{micVolume > 0.01 ? 'DETECTING VOICE' : 'SILENT'}</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div 
                        className="bg-green-500 h-1.5 transition-all duration-75" 
                        style={{ width: `${Math.min(100, micVolume * 500)}%` }} 
                      />
                    </div>
                  </div>
               </div>
            )}
            
            {/* Chat Input */}
            <form onSubmit={sendTextMessage} className="mt-4 flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Type a message..."
                disabled={status !== ConnectionStatus.CONNECTED}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
              <button 
                type="submit"
                disabled={status !== ConnectionStatus.CONNECTED || !inputText.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              >
                Send
              </button>
            </form>
          </div>

          <div className="p-4 bg-slate-900/50 border-t border-slate-700 text-[10px] text-slate-500 text-center uppercase tracking-widest font-bold">
            Powered by Gemini 2.5 Flash Native
          </div>
        </div>
      </div>

      {/* Footer Branding */}
      <div className="mt-12 text-slate-600 flex items-center space-x-6 text-sm font-medium">
        <span className="flex items-center space-x-2">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" /></svg>
          <span>Multi-modal AI</span>
        </span>
        <span className="flex items-center space-x-2">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.342l-7 4A1 1 0 003.5 7.081V15a1 1 0 00.5.866l7 4a1 1 0 001-1.732l-6.5-3.714V7.63l6.5 3.714a1 1 0 101-1.732l-7-4z" clipRule="evenodd" /></svg>
          <span>Zero Latency PCM</span>
        </span>
        <span className="flex items-center space-x-2">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z" /><path fillRule="evenodd" d="M.458 10C1.732 5.943 5.523 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" /></svg>
          <span>Real-time OCR</span>
        </span>
      </div>
    </div>
  );
};

export default App;
