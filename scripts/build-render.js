import { build } from 'vite';

process.env.VITE_BASE_PATH = '/';
process.env.VITE_ROUTER_MODE = 'history';

await build();
