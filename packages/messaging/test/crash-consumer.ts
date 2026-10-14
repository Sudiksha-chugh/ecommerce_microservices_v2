import {Messaging} from '../src/index.js';
const manager=new Messaging(JSON.parse(process.env.TEST_MESSAGING!),['inventory'],() => {});
manager.register('inventory.order-created.v1',async () => {process.kill(process.pid,'SIGKILL');});manager.start();
const timer=setInterval(() => {if(manager.status==='ready'){clearInterval(timer);process.send?.('ready');}},10);
