-- Standalone Redis only. All policy buckets are evaluated and spent together.
-- Integer balance units = tokens * windowMs; refill adds elapsedMs * refillTokens.
-- Limits in policySchema keep every arithmetic intermediate below 2^53.
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local states = {}
local allowed = 1
for i, key in ipairs(KEYS) do
  local offset = (i - 1) * 3
  local capacity = tonumber(ARGV[offset + 1])
  local refill = tonumber(ARGV[offset + 2])
  local window = tonumber(ARGV[offset + 3])
  local fullMs = math.ceil(capacity * window / refill)
  local saved = redis.call('HMGET', key, 'tokens', 'last', 'capacity', 'refill', 'window')
  if saved[3] and (tonumber(saved[3]) ~= capacity or tonumber(saved[4]) ~= refill or tonumber(saved[5]) ~= window) then
    return redis.error_reply('RL_POLICY_MISMATCH')
  end
  local tokens = capacity * window
  if saved[1] then
    local last = tonumber(saved[2])
    local balance = tonumber(saved[1])
    if not last or not balance or balance < 0 or balance > tokens then return redis.error_reply('RL_INVALID_STATE') end
    local elapsed = math.min(fullMs, math.max(0, now - last))
    tokens = math.min(tokens, balance + elapsed * refill)
    -- Never move the refill clock backwards if the Redis wall clock is adjusted.
    -- Persist the effective clock separately for each bucket.
  end
  if tokens < window then allowed = 0 end
  states[i] = {tokens = tokens, capacity = capacity, refill = refill, window = window, ttl = math.max(1000, fullMs), last = math.max(now, tonumber(saved[2]) or now)}
end
local result = {allowed}
for i, key in ipairs(KEYS) do
  local s = states[i]
  local balance = s.tokens - (allowed == 1 and s.window or 0)
  redis.call('HSET', key, 'tokens', balance, 'last', s.last, 'capacity', s.capacity, 'refill', s.refill, 'window', s.window)
  redis.call('PEXPIRE', key, s.ttl)
  result[i + 1] = {math.floor(balance / s.window), math.max(0, math.ceil((s.window - balance) / s.refill)), math.ceil((s.capacity * s.window - balance) / s.refill)}
end
return result
