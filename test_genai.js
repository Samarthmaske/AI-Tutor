import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    console.log('Testing gemini-2.5-flash-native-audio-preview-09-2025...');
    const session = await ai.live.connect({ model: 'gemini-2.5-flash-native-audio-preview-09-2025' });
    console.log('2.5 live connect success!');
    
    // Try sending an object
    try {
      console.log('Sending object...');
      session.sendRealtimeInput({ media: { data: 'AABB', mimeType: 'audio/pcm;rate=16000' } });
      console.log('Object sent successfully');
    } catch(e) { console.error('Object failed:', e.message); }

    // Try sending an array of parts
    try {
      console.log('Sending array...');
      session.sendRealtimeInput([{ media: { data: 'AABB', mimeType: 'audio/pcm;rate=16000' } }]);
      console.log('Array sent successfully');
    } catch(e) { console.error('Array failed:', e.message); }
    
    setTimeout(() => session.close(), 2000);
    
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
