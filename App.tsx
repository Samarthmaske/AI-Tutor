
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, Message } from './types';
import { decode, encode, decodeAudioData, createPcmBlob } from './services/audioUtils';

// --- Constants ---
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';
const FRAME_RATE = 1; // 1 frame per second for vision input
const JPEG_QUALITY = 0.6;

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      // 1. Get User Media (Mic)
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      // 2. Get Screen Stream
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" } as any,
        audio: false,
      });
      streamRef.current = screenStream;
      setIsScreenSharing(true);

      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
      }

      // 3. Setup Audio Contexts
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const outputNode = outputAudioCtxRef.current.createGain();
      outputNode.connect(outputAudioCtxRef.current.destination);

      // 4. Connect to Gemini Live API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: "You are a screen sharing assistant. You can see the user's screen through periodic snapshots. Assist the user with whatever is on their screen. Be concise and conversational.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('Gemini Live session opened');
            setStatus(ConnectionStatus.CONNECTED);
            
            // Start streaming mic audio
            if (inputAudioCtxRef.current) {
              const source = inputAudioCtxRef.current.createMediaStreamSource(micStream);
              const scriptProcessor = inputAudioCtxRef.current.createScriptProcessor(4096, 1, 1);
              scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createPcmBlob(inputData);
                sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              };
              source.connect(scriptProcessor);
              scriptProcessor.connect(inputAudioCtxRef.current.destination);
            }

            // Start streaming screen frames
            frameIntervalRef.current = window.setInterval(() => {
              if (videoRef.current && canvasRef.current && sessionRef.current) {
                const video = videoRef.current;
                const canvas = canvasRef.current;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
                  canvas.toBlob(async (blob) => {
                    if (blob) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64Data = (reader.result as string).split(',')[1];
                        sessionPromise.then(session => {
                          session.sendRealtimeInput({
                            media: { data: base64Data, mimeType: 'image/jpeg' }
                          });
                        });
                      };
                      reader.readAsDataURL(blob);
                    }
                  }, 'image/jpeg', JPEG_QUALITY);
                }
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Transcription for History
            if (message.serverContent?.inputTranscription) {
               // Optional: Show live transcriptions
            }
            if (message.serverContent?.outputTranscription) {
               // Optional: Show live model responses
            }
            if (message.serverContent?.turnComplete) {
              // End of a turn
            }

            // Handle Audio Playback
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
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
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => {
                try { s.stop(); } catch (e) {}
              });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Gemini Live error:', e);
            setError('An error occurred with the AI session.');
            cleanup();
          },
          onclose: () => {
            console.log('Gemini Live session closed');
            cleanup();
          }
        }
      });

      sessionRef.current = await sessionPromise;

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
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/50 rounded-lg flex space-x-2 text-red-400 animate-in fade-in slide-in-from-bottom-2">
                <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <p className="text-xs font-medium">{error}</p>
              </div>
            )}

            {status === ConnectionStatus.CONNECTED && (
               <div className="p-4 bg-indigo-600/10 border border-indigo-500/30 rounded-xl space-y-2">
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 animate-ping" />
                    <span className="text-xs font-bold text-indigo-300 uppercase">Live Session Active</span>
                  </div>
                  <p className="text-xs text-slate-400">Gemini is processing your screen data and audio in real-time.</p>
               </div>
            )}
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
