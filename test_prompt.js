import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const ai = new GoogleGenAI({ apiKey: process.env.VITE_GEMINI_API_KEY });
import { Modality } from '@google/genai';
console.log('Modality is:', Modality);

async function runTest() {
  console.log('Connecting to Gemini...');
  const session = await ai.live.connect({
    model: 'gemini-2.5-flash-native-audio-preview-09-2025',
    config: {},
    callbacks: {
      onmessage: (message) => {
        if (message.serverContent && message.serverContent.modelTurn) {
            const parts = message.serverContent.modelTurn.parts;
            const audioPart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('audio'));
            if (audioPart) {
                console.log('Audio part keys:', Object.keys(audioPart.inlineData));
                console.log('Is data present?', !!audioPart.inlineData.data);
                process.exit(0);
            }
        }
      },
      onclose: () => { console.log('Session closed'); },
      onerror: (err) => { console.error('Error from API:', err); }
    }
  });
  
  console.log('Connected! Sending prompt...');
  try {
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: "Hello, Gemini! Please say hi!" }] }],
      turnComplete: true,
    });
    console.log('Prompt sent. Waiting for response...');
  } catch (err) {
    console.error('Failed to send:', err);
  }
}

runTest().catch(console.error);
