import express from 'express';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Serve static files in production
app.use(express.static(path.join(__dirname, 'dist')));

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const language = url.searchParams.get('lang') || 'English';
  console.log(`Client connected to WebSocket relay. Requested Language: ${language}`);
  
  let session = null;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    // Configure Gemini Live Session
    session = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: ["AUDIO"],
        systemInstruction: { parts: [{ text: `You are a screen sharing assistant. You can see the user's screen through periodic snapshots. Assist the user with whatever is on their screen. Be concise and conversational. You MUST respond in the following language: ${language}.` }] }
      },
      callbacks: {
        onmessage: (message) => {
          if (message.serverContent) {
             const parts = message.serverContent.modelTurn?.parts;
             const hasText = parts?.some((p) => p.text);
             const hasAudio = parts?.some((p) => p.inlineData && p.inlineData.mimeType?.startsWith('audio'));
             if (hasText) {
                 console.log(`Gemini Text Output:`, JSON.stringify(parts.filter((p) => p.text)));
             }
          } else {
             console.log('Gemini message type:', message.setupComplete ? 'setupComplete' : 'other');
          }
          
          if (message.setupComplete) {
            console.log('Gemini Setup Complete');
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'connected' }));
            }
            try {
              session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: `Hi, I just connected! Please say a very short greeting in ${language}.` }] }],
                turnComplete: true,
              });
            } catch(e) {
              console.error('Failed to send initial greeting prompt:', e);
            }
          }

          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify(message));
            } catch (err) {
              console.error('Error stringifying message from Gemini:', err);
            }
          }
        },
        onerror: (err) => {
          console.error('Gemini error:', err);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ error: err.message || 'Gemini Error' }));
          }
        },
        onclose: () => {
          console.log('Gemini session closed');
          if (ws.readyState === ws.OPEN) ws.close();
        }
      }
    });

    console.log('Successfully connected to Gemini Live API, waiting for setupComplete...');

    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        if (payload.type === 'end_of_turn') {
            console.log('Client aggressive VAD triggered end_of_turn');
            if (session) {
                session.sendRealtimeInput({ audioStreamEnd: true });
            }
        } else if (payload.media) {
            console.log('Received media chunk from client:', payload.media.mimeType, 'length:', payload.media.data?.length);
            if (session) {
                session.sendRealtimeInput({
                    media: {
                        mimeType: payload.media.mimeType,
                        data: payload.media.data
                    }
                });
            }
        } else if (payload.clientContent && session) {
            session.sendClientContent(payload.clientContent);
        } else if (session) {
            session.sendRealtimeInput(payload);
        }
      } catch (err) {
        console.error('Error parsing client message:', err);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      if (session) {
        try { session.close(); } catch(e){}
      }
    });

  } catch (err) {
    console.error('Failed to connect to Gemini:', err);
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ error: 'Failed to connect to AI server.' }));
        ws.close();
    }
  }
});
