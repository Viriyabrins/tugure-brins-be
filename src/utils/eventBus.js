import { EventEmitter } from 'node:events';

const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

export default eventBus;