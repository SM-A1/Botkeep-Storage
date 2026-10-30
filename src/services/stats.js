import { redis } from './redis.js';
import { K } from './keys.js';
import { CATEGORIES } from '../utils/category.js';

function parse(h) {
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = { count: Math.max(0, Number(h?.[`c:${c}`]) || 0), bytes: Math.max(0, Number(h?.[`b:${c}`]) || 0) };
  return { files: Math.max(0, Number(h?.files) || 0), bytes: Math.max(0, Number(h?.bytes) || 0), byCat };
}

export const getUserStats = async (uid) => parse(await redis.hgetall(K.ustats(uid)));
export const getGlobalStats = async () => parse(await redis.hgetall(K.gstats));
