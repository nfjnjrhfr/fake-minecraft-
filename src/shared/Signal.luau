--!strict
--[[ A minimal signal. BindableEvents copy their arguments, which would turn
     every chunk handed between systems into a deep copy. ]]

export type Connection = { disconnect: (self: Connection) -> () }

local Signal = {}
Signal.__index = Signal

export type Signal = typeof(setmetatable({} :: { handlers: { (...any) -> () } }, Signal))

function Signal.new(): Signal
	return setmetatable({ handlers = {} }, Signal)
end

function Signal.connect(self: Signal, handler: (...any) -> ()): Connection
	table.insert(self.handlers, handler)

	local connection = {}
	function connection.disconnect()
		local index = table.find(self.handlers, handler)
		if index then
			table.remove(self.handlers, index)
		end
	end
	return connection :: any
end

function Signal.fire(self: Signal, ...: any)
	-- Iterate a copy: a handler is allowed to disconnect itself.
	for _, handler in table.clone(self.handlers) do
		local ok, err = pcall(handler, ...)
		if not ok then
			warn("[Signal] handler error: " .. tostring(err))
		end
	end
end

function Signal.destroy(self: Signal)
	table.clear(self.handlers)
end

return Signal
