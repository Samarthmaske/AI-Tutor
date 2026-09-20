import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Test client connected to server.');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received from server:', Object.keys(msg));
  if (msg.type === 'connected') {
    console.log('Got connected event!');
  }
  
  if (msg.serverContent) {
     const parts = msg.serverContent.modelTurn?.parts;
     const hasText = parts?.some(p => p.text);
     console.log('Server Content parts keys:', parts ? parts.map(p => Object.keys(p)) : 'none');
     if (hasText) {
         console.log('Text content:', JSON.stringify(parts.filter(p => p.text)));
     }
     const audioPart = parts?.find(p => p.inlineData);
     if (audioPart) {
         console.log('inlineData mimeType:', audioPart.inlineData.mimeType);
         const b64 = audioPart.inlineData.data;
         const binaryStr = atob(b64);
         console.log('Decoded byte length:', binaryStr.length, 'Is even?', binaryStr.length % 2 === 0);
     }
  }
});

ws.on('error', (err) => console.error(err));
ws.on('close', () => console.log('Closed'));
