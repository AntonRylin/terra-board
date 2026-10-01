const { Store } = require('../electron/store.cjs');
const s = new Store(process.argv[2]);
const b = s.createBoard({ name: 'Before abrupt exit' });
s.patchBoard({
  id: b.id,
  revision: 0,
  operationId: 'durable-write',
  upserts: [
    {
      id: 'saved',
      type: 'note',
      x: 0,
      y: 0,
      width: 200,
      height: 150,
      z: 1,
      text: 'Acknowledged',
      color: '#f8efd4',
    },
  ],
  deleted: [],
});
process.send({ id: b.id });
setInterval(() => {}, 1000);
