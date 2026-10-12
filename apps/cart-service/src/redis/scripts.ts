// Each script runs against one owner-specific hash. Limit checking, mutation,
// TTL refresh, and the returned snapshot happen in one atomic Redis operation.
export const addItemScript = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
local quantity = current + tonumber(ARGV[2])
if quantity > tonumber(ARGV[3]) then return {-1, {}} end
redis.call('HSET', KEYS[1], ARGV[1], quantity)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return {1, redis.call('HGETALL', KEYS[1])}
`;
export const updateItemScript = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return {0, {}} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, redis.call('HGETALL', KEYS[1])}
`;
export const removeItemScript = `
if redis.call('HDEL', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;
