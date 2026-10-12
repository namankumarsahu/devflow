import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { attachLogServer } from './ws/logs';

const server = http.createServer(createApp());
attachLogServer(server);
server.listen(config.port, () => console.log(`DevFlow API listening on :${config.port}`));
