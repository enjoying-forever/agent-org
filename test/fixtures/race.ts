// One racer: waits for the start time, then claims a file. Prints whether it won.
import { Store } from '../../src/store.ts';

const [db, role, start] = process.argv.slice(2);
const store = new Store(db);
while (Date.now() < Number(start)) { /* wait for the others */ }
const won = store.claim('src/race.py', 'src/race.py', role).owner === role;
store.close();
process.stdout.write(won ? 'won' : 'lost');
