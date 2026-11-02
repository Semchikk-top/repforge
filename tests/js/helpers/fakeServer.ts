// Сервер в памяти для тестов синхронизации: то же правило победителя, что в server/db.py.
interface Ent { table: string; id: string; updatedAt: number; deviceId: string; deleted: boolean; data: Record<string, unknown>; seq: number }
export class FakeServer {
  seq = 0; ents = new Map<string, Ent>(); requests: Array<{ since: number; n: number }> = [];
  push(table: string, id: string, updatedAt: number, deviceId: string, data: Record<string, unknown>, deleted = false): boolean {
    const cur = this.ents.get(`${table}/${id}`);
    if (cur && (cur.updatedAt > updatedAt || (cur.updatedAt === updatedAt && cur.deviceId >= deviceId))) return false;
    this.ents.set(`${table}/${id}`, { table, id, updatedAt, deviceId, deleted, data: JSON.parse(JSON.stringify(data)), seq: ++this.seq });
    return true;
  }
  handle(body: { since: number; entities: Array<{ table: string; id: string; updatedAt: number; deviceId: string; deleted: boolean; data: Record<string, unknown> }> }) {
    this.requests.push({ since: body.since, n: body.entities.length });
    const accepted = new Set<string>();
    for (const e of body.entities) if (this.push(e.table, e.id, e.updatedAt, e.deviceId, e.data, e.deleted)) accepted.add(`${e.table}/${e.id}`);
    const entities = [...this.ents.values()].filter((e) => e.seq > body.since && !accepted.has(`${e.table}/${e.id}`));
    return { seq: this.seq, more: false, accepted: accepted.size, entities, protocol: 1, minClientProtocol: 1, schema: 1, serverTime: Date.now() };
  }
}
