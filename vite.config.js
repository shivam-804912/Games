import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import playverseRooms from './server/rooms.js';

export default defineConfig({
  plugins: [react(), playverseRooms()],
  // Listen on the local network so phones on the same Wi-Fi can join as controllers.
  server: { host: true },
  preview: { host: true },
});
