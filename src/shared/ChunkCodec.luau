--!strict
--[[
	Run-length codec for chunk block data.

	A chunk is 16 KiB raw, which is far too much to hand to a RemoteEvent per
	chunk. Terrain is made of long vertical runs of the same block, and the
	buffer is laid out y-major, so run-length encoding takes a typical chunk
	down to a few hundred bytes.

	Wire format: repeated pairs of (varint run length, u8 block id).
]]

local Chunk = require(script.Parent.Chunk)
local Coordinates = require(script.Parent.Coordinates)

local VOLUME = Coordinates.VolumePerChunk
local MAX_RUN = VOLUME

local ChunkCodec = {}

--[[ Run lengths are varints: one byte below 128, two above. Most runs in a
     chunk are short, so a fixed-width length would waste a byte on each. ]]
local function writeVarint(target: buffer, offset: number, value: number): number
	while value >= 128 do
		buffer.writeu8(target, offset, value % 128 + 128)
		offset += 1
		value = math.floor(value / 128)
	end
	buffer.writeu8(target, offset, value)
	return offset + 1
end

local function readVarint(source: buffer, offset: number): (number, number)
	local value = 0
	local shift = 1

	while offset < buffer.len(source) do
		local byte = buffer.readu8(source, offset)
		offset += 1
		value += (byte % 128) * shift
		if byte < 128 then
			return value, offset
		end
		shift *= 128
	end

	return value, offset
end

function ChunkCodec.encode(chunk: Chunk.Chunk): string
	local blocks = chunk.blocks
	-- Worst case is one run per voxel: three bytes each.
	local scratch = buffer.create(VOLUME * 3)
	local offset = 0

	local runId = buffer.readu8(blocks, 0)
	local runLength = 1

	local function flush()
		offset = writeVarint(scratch, offset, runLength)
		buffer.writeu8(scratch, offset, runId)
		offset += 1
	end

	for index = 1, VOLUME - 1 do
		local blockId = buffer.readu8(blocks, index)
		if blockId == runId and runLength < MAX_RUN then
			runLength += 1
		else
			flush()
			runId = blockId
			runLength = 1
		end
	end
	flush()

	local packed = buffer.create(offset)
	buffer.copy(packed, 0, scratch, 0, offset)
	return buffer.tostring(packed)
end

--[[ Fills `chunk` from an encoded payload. Returns false on a malformed one
     rather than throwing, because this data arrives over the network. ]]
function ChunkCodec.decodeInto(chunk: Chunk.Chunk, payload: string): boolean
	local source = buffer.fromstring(payload)
	local length = buffer.len(source)
	local blocks = chunk.blocks
	local index = 0
	local offset = 0

	while offset < length do
		local runLength, next = readVarint(source, offset)
		if next >= length + 1 or runLength == 0 then
			return false
		end

		local blockId = buffer.readu8(source, next)
		offset = next + 1

		if index + runLength > VOLUME then
			return false
		end

		buffer.fill(blocks, index, blockId, runLength)
		index += runLength
	end

	if index ~= VOLUME then
		return false
	end

	chunk:buildHeightMap()
	return true
end

function ChunkCodec.decode(cx: number, cz: number, payload: string): Chunk.Chunk?
	local chunk = Chunk.new(cx, cz)
	if not ChunkCodec.decodeInto(chunk, payload) then
		return nil
	end
	return chunk
end

--[[ Player edits, packed for the datastore: (u32 index, u8 block id) pairs. ]]
function ChunkCodec.encodeEdits(edits: { [number]: number }): string
	local pieces: { string } = {}
	for index, blockId in edits do
		table.insert(pieces, string.pack("<I4B", index, blockId))
	end
	return table.concat(pieces)
end

function ChunkCodec.decodeEdits(payload: string): { [number]: number }
	local edits: { [number]: number } = {}
	if #payload % 5 ~= 0 then
		return edits
	end

	local offset = 1
	while offset <= #payload do
		local index, blockId, nextOffset = string.unpack("<I4B", payload, offset)
		offset = nextOffset
		if index < VOLUME then
			edits[index] = blockId
		end
	end
	return edits
end

return ChunkCodec
