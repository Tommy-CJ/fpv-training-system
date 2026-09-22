export const EQUIPMENT_TYPES = [
  { key: "single", label: "单门" },
  { key: "sun", label: "日字门" },
  { key: "gravity", label: "重力门" },
  { key: "doubleGravity", label: "双层重力门" },
  { key: "triple", label: "三层门" },
  { key: "flag", label: "刀旗" },
  { key: "sandbag", label: "沙包" },
];

export const DEFAULT_TRANSPORT_RULES = {
  single: { name: "单门", qty: 4, people: 1, cart: 1, minutes: 10, difficulty: 2, enabled: true, note: "小车搬运，支持 4/5 个、1/2 人候选" },
  sun: { name: "日字门", qty: 2, people: 1, cart: 0, minutes: 8, difficulty: 4, enabled: true, note: "支持 1/2 人候选" },
  gravity: { name: "重力门", qty: 1, people: 1, cart: 0, minutes: 8, difficulty: 1, enabled: true, note: "自带轮子" },
  doubleGravity: { name: "双层重力门", qty: 1, people: 2, cart: 0, minutes: 10, difficulty: 5, enabled: true, note: "固定 2 人" },
  triple: { name: "三层门", qty: 1, people: 1, cart: 0, minutes: 15, difficulty: 3, enabled: true, note: "固定 1 人，有轮子" },
  flag: { name: "刀旗", qty: 4, people: 1, cart: 0, minutes: 4, difficulty: 1, enabled: true, note: "轻量器材" },
};

export const DEFAULT_TRANSPORT_CONFIG = {
  counts: { single: 0, sun: 0, gravity: 0, doubleGravity: 0, triple: 0, flag: 0, sandbag: 0 },
  peopleStart: 5,
  carts: 1,
  maxTrips: 3,
  nodeLimit: 1000000,
  wind: false,
  sandbags: null,
  rules: DEFAULT_TRANSPORT_RULES,
  params: {
    singleQtyNormal: 4,
    singleQtyMax: 5,
    singleTwoPeopleCoef: 0.9,
    singleFiveCoef: 1.15,
    sunTwoPeopleCoef: 0.85,
    sunSandPerGate: 2,
    singleSandPerGate: 2,
    sandHandQty: 2,
    sandHandTime: 6,
    sandCartQty: 6,
    sandCartTime: 5,
    wTime: 100,
    wIdle: 80,
    wFatigue: 18,
    wHardStreak: 25,
    wTripBalance: 45,
  },
};

export function circledNumber(n) {
  const items = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
  return items[n] || `(${n})`;
}

export function displayTaskName(name) {
  return String(name || "")
    .split(" 对应 ")[0]
    .replace(/#?(\d+)$/g, (_, n) => circledNumber(Number(n)));
}
