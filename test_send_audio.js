import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const session = await ai.live.connect({ 
    model: 'gemini-2.5-flash-native-audio-preview-09-2025',
    callbacks: {
       onmessage: (msg) => {
         if (msg.serverContent?.modelTurn) {
             console.log('Got model turn!');
         }
       }
    }
  });

  console.log('Connected');

  // Send 1 second of NOISY PCM 16000Hz (32000 bytes)
  const noisyBuffer = Buffer.alloc(32000);
  for (let i = 0; i < noisyBuffer.length; i++) {
     noisyBuffer[i] = Math.floor(Math.random() * 256);
  }
  const noisyPcm = noisyBuffer.toString('base64');

  try {
     console.log('Trying format 1: [{ media: { ... } }]');
     session.sendRealtimeInput([{ media: { mimeType: 'audio/pcm;rate=16000', data: noisyPcm } }]);
     console.log('Format 1 accepted');
  } catch(e) { console.error('Format 1 error:', e.message); }

  try {
     console.log('Trying format 2: [{ mimeType, data }]');
     session.sendRealtimeInput([{ mimeType: 'audio/pcm;rate=16000', data: noisyPcm }]);
     console.log('Format 2 accepted');
  } catch(e) { console.error('Format 2 error:', e.message); }

  try {
     console.log('Trying format 3: { media: { ... } }');
     session.sendRealtimeInput({ media: { mimeType: 'audio/pcm;rate=16000', data: noisyPcm } });
     console.log('Format 3 accepted');
  } catch(e) { console.error('Format 3 error:', e.message); }

  setTimeout(() => process.exit(0), 10000);
}
test();
