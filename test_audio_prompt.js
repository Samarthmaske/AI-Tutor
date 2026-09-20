import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const session = await ai.live.connect({ 
    model: 'gemini-2.5-flash-native-audio-preview-09-2025',
    config: {
        responseModalities: ["AUDIO"]
    },
    callbacks: {
        onmessage: (msg) => {
            console.log('Got msg:', Object.keys(msg));
            if (msg.serverContent?.modelTurn?.parts) {
                console.log('PARTS keys:', msg.serverContent.modelTurn.parts.map(p => Object.keys(p)));
            }
        },
        onclose: () => console.log('Closed')
    }
  });

  // Try sending text prompt
  session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: "Hello! Say hi." }] }],
      turnComplete: true
  });
}
test();
