--!strict
--[[
	Roblox Studio Bridge

	Connects Studio to the local bridge server (`node server/bridge.js serve`)
	and keeps the DataModel in sync with the files on disk.

	  disk  --(long poll)-->  plugin  -->  DataModel      "push"
	  DataModel  -->  plugin  --(POST)-->  disk           "pull"

	Only instances the bridge created are ever touched: every managed instance
	is tagged with the BRIDGE_ATTRIBUTE attribute, so hand-made instances in the
	place file are left alone.
]]

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local ScriptEditorService = game:GetService("ScriptEditorService")

local PROTOCOL_VERSION = 1
local DEFAULT_URL = "http://localhost:34873"
local BRIDGE_ATTRIBUTE = "RobloxStudioBridge"
local RECONNECT_DELAY = 2
local MAX_LOG_LINES = 200

type Node = {
	path: { string },
	className: string,
	source: string?,
	relPath: string?,
}

type Tracked = {
	instance: Instance,
	relPath: string?,
}

local state = {
	connected = false,
	url = DEFAULT_URL,
	revision = 0,
	generation = 0,
	tracked = {} :: { [string]: Tracked },
	status = "Disconnected",
}

--------------------------------------------------------------------------------
-- Logging
--------------------------------------------------------------------------------

local pendingLog: { string } = {}
local logChanged: ((line: string) -> ())? = nil

local function appendLog(message: string)
	if logChanged then
		logChanged(message)
	else
		-- The panel is not built yet; replay these once it is.
		table.insert(pendingLog, message)
	end
end

local function logInfo(message: string)
	appendLog(message)
	print("[Bridge] " .. message)
end

local function logWarn(message: string)
	appendLog("! " .. message)
	warn("[Bridge] " .. message)
end

--------------------------------------------------------------------------------
-- HTTP
--------------------------------------------------------------------------------

local function request(method: string, endpoint: string, body: any): (boolean, any)
	local options: { [string]: any } = {
		Url = state.url .. endpoint,
		Method = method,
		Headers = { ["Content-Type"] = "application/json" },
	}
	if body ~= nil then
		options.Body = HttpService:JSONEncode(body)
	end

	local ok, response = pcall(function()
		return HttpService:RequestAsync(options)
	end)

	if not ok then
		return false, tostring(response)
	end
	if not response.Success then
		return false, string.format("HTTP %d %s", response.StatusCode, response.StatusMessage)
	end

	local decoded
	ok, decoded = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not ok then
		return false, "Server sent a response that is not JSON"
	end

	return true, decoded
end

--------------------------------------------------------------------------------
-- Applying a snapshot to the DataModel
--------------------------------------------------------------------------------

local function getRoot(name: string): Instance?
	local ok, service = pcall(function()
		return game:GetService(name :: any)
	end)
	if ok and service then
		return service
	end
	return game:FindFirstChild(name)
end

local function resolveParent(path: { string }): Instance?
	local current = getRoot(path[1])
	if not current then
		logWarn("No service or instance named " .. path[1])
		return nil
	end

	for index = 2, #path - 1 do
		local segment = path[index]
		local child = current:FindFirstChild(segment)
		if not child then
			-- Ancestors of a mapped path (StarterPlayerScripts and friends)
			-- normally exist already; anything missing is created as a Folder
			-- and marked as ours so it can be cleaned up again.
			local folder = Instance.new("Folder")
			folder.Name = segment
			folder:SetAttribute(BRIDGE_ATTRIBUTE, true)
			folder.Parent = current
			child = folder
		end
		current = child
	end

	return current
end

local function setSource(scriptInstance: LuaSourceContainer, source: string)
	local current = (scriptInstance :: any).Source
	if current == source then
		return
	end

	-- UpdateSourceAsync keeps open editor tabs and undo history intact.
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(scriptInstance, function()
			return source
		end)
	end)

	if not ok then
		local fallbackOk, fallbackErr = pcall(function()
			(scriptInstance :: any).Source = source
		end)
		if not fallbackOk then
			logWarn(string.format("Could not write %s: %s (%s)", scriptInstance:GetFullName(), tostring(fallbackErr), tostring(err)))
		end
	end
end

local function applyNode(node: Node): Instance?
	local parent = resolveParent(node.path)
	if not parent then
		return nil
	end

	local name = node.path[#node.path]
	local existing = parent:FindFirstChild(name)

	if existing and existing.ClassName ~= node.className then
		if existing:GetAttribute(BRIDGE_ATTRIBUTE) then
			existing:Destroy()
			existing = nil
		else
			logWarn(string.format("%s already exists as a %s and is not managed by the bridge - skipping", existing:GetFullName(), existing.ClassName))
			return nil
		end
	end

	if not existing then
		local created = Instance.new(node.className :: any)
		created.Name = name
		created:SetAttribute(BRIDGE_ATTRIBUTE, true)
		created.Parent = parent
		existing = created
	elseif not existing:GetAttribute(BRIDGE_ATTRIBUTE) then
		-- An instance already matches the file tree exactly: adopt it, so from
		-- now on the file on disk is the source of truth for it.
		existing:SetAttribute(BRIDGE_ATTRIBUTE, true)
		logInfo("Adopted existing " .. existing:GetFullName())
	end

	if node.source and existing:IsA("LuaSourceContainer") then
		setSource(existing :: LuaSourceContainer, node.source)
	end

	return existing
end

local function pruneRemoved(nextTracked: { [string]: Tracked })
	local removed = 0
	for key, entry in state.tracked do
		if nextTracked[key] == nil then
			local instance = entry.instance
			if instance and instance.Parent and instance:GetAttribute(BRIDGE_ATTRIBUTE) then
				instance:Destroy()
				removed += 1
			end
		end
	end
	if removed > 0 then
		logInfo(string.format("Removed %d instance(s) that no longer exist on disk", removed))
	end
end

local function applySnapshot(payload: any)
	local nodes: { Node } = payload.nodes or {}
	local nextTracked: { [string]: Tracked } = {}

	local recording = ChangeHistoryService:TryBeginRecording("Bridge sync", "Bridge sync")

	for _, node in nodes do
		local instance = applyNode(node)
		if instance then
			nextTracked[table.concat(node.path, "/")] = {
				instance = instance,
				relPath = node.relPath,
			}
		end
	end

	pruneRemoved(nextTracked)
	state.tracked = nextTracked
	state.revision = payload.revision or state.revision

	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end

	logInfo(string.format("Synced revision %d - %d instance(s)", state.revision, #nodes))
end

--------------------------------------------------------------------------------
-- Studio -> disk
--------------------------------------------------------------------------------

local function pullFromStudio()
	local files = {}

	for _, entry in state.tracked do
		local instance = entry.instance
		if entry.relPath and instance and instance.Parent and instance:IsA("LuaSourceContainer") then
			table.insert(files, {
				relPath = entry.relPath,
				source = (instance :: any).Source,
			})
		end
	end

	if #files == 0 then
		logWarn("Nothing to pull - connect and sync first")
		return
	end

	local ok, result = request("POST", "/api/pull", { files = files })
	if not ok then
		logWarn("Pull failed: " .. tostring(result))
		return
	end

	local written = result.written or {}
	if #written == 0 then
		logInfo("Pull finished - every file already matched the disk")
	else
		logInfo(string.format("Wrote %d file(s) back to disk", #written))
		for _, relPath in written do
			logInfo("  " .. tostring(relPath))
		end
	end

	for _, item in result.rejected or {} do
		logWarn(string.format("Refused %s: %s", tostring(item.relPath), tostring(item.reason)))
	end
end

--------------------------------------------------------------------------------
-- Connection loop
--------------------------------------------------------------------------------

local setStatus: (status: string) -> ()

local function syncOnce(): boolean
	local ok, payload = request("GET", "/api/snapshot", nil)
	if not ok then
		logWarn("Sync failed: " .. tostring(payload))
		return false
	end
	applySnapshot(payload)
	return true
end

local function connectionLoop(generation: number)
	while state.connected and state.generation == generation do
		local ok, payload = request("GET", "/api/poll?since=" .. tostring(state.revision), nil)

		if not state.connected or state.generation ~= generation then
			return
		end

		if not ok then
			setStatus("Reconnecting")
			logWarn("Lost the bridge server (" .. tostring(payload) .. "); retrying")
			task.wait(RECONNECT_DELAY)
		elseif payload.unchanged then
			setStatus("Connected")
		else
			applySnapshot(payload)
			setStatus("Connected")
		end
	end
end

local function connect()
	if state.connected then
		return
	end

	local ok, info = request("GET", "/api/info", nil)
	if not ok then
		setStatus("Disconnected")
		logWarn("Could not reach " .. state.url .. " (" .. tostring(info) .. ")")
		logWarn("Start the server with: node server/bridge.js serve")
		return
	end

	if info.protocolVersion ~= PROTOCOL_VERSION then
		setStatus("Disconnected")
		logWarn(string.format("Protocol mismatch: plugin speaks v%d, server speaks v%s", PROTOCOL_VERSION, tostring(info.protocolVersion)))
		return
	end

	state.connected = true
	state.revision = 0
	state.generation += 1
	setStatus("Connected")
	logInfo("Connected to project \"" .. tostring(info.projectName) .. "\" at " .. state.url)

	local generation = state.generation
	task.spawn(function()
		if syncOnce() then
			connectionLoop(generation)
		else
			state.connected = false
			setStatus("Disconnected")
		end
	end)
end

local function disconnect()
	if not state.connected then
		return
	end
	state.connected = false
	state.generation += 1
	setStatus("Disconnected")
	logInfo("Disconnected")
end

--------------------------------------------------------------------------------
-- User interface
--------------------------------------------------------------------------------

local toolbar = plugin:CreateToolbar("Bridge")
local toggleButton = toolbar:CreateButton("Bridge", "Open the Roblox Studio bridge panel", "")
toggleButton.ClickableWhenViewportHidden = true

local widget = plugin:CreateDockWidgetPluginGui(
	"RobloxStudioBridge",
	DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 300, 380, 260, 220)
)
widget.Title = "Bridge"
widget.Name = "RobloxStudioBridge"

local theme = settings().Studio.Theme

local function themeColor(item: Enum.StudioStyleGuideColor, modifier: Enum.StudioStyleGuideModifier?): Color3
	return theme:GetColor(item, modifier or Enum.StudioStyleGuideModifier.Default)
end

local background = Instance.new("Frame")
background.Size = UDim2.fromScale(1, 1)
background.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.MainBackground)
background.BorderSizePixel = 0
background.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 6)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = background

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 8)
padding.PaddingBottom = UDim.new(0, 8)
padding.PaddingLeft = UDim.new(0, 8)
padding.PaddingRight = UDim.new(0, 8)
padding.Parent = background

local function makeLabel(text: string, order: number): TextLabel
	local label = Instance.new("TextLabel")
	label.Size = UDim2.new(1, 0, 0, 18)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.SourceSansBold
	label.TextSize = 15
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextColor3 = themeColor(Enum.StudioStyleGuideColor.MainText)
	label.Text = text
	label.LayoutOrder = order
	label.Parent = background
	return label
end

local function makeButton(text: string, order: number, onClick: () -> ()): TextButton
	local button = Instance.new("TextButton")
	button.Size = UDim2.new(1, 0, 0, 28)
	button.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.Button)
	button.BorderSizePixel = 0
	button.Font = Enum.Font.SourceSans
	button.TextSize = 15
	button.TextColor3 = themeColor(Enum.StudioStyleGuideColor.ButtonText)
	button.Text = text
	button.LayoutOrder = order
	button.AutoButtonColor = true
	button.Parent = background

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = button

	button.Activated:Connect(onClick)
	return button
end

local statusLabel = makeLabel("Disconnected", 1)

local urlBox = Instance.new("TextBox")
urlBox.Size = UDim2.new(1, 0, 0, 26)
urlBox.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.InputFieldBackground)
urlBox.BorderSizePixel = 0
urlBox.Font = Enum.Font.Code
urlBox.TextSize = 14
urlBox.TextColor3 = themeColor(Enum.StudioStyleGuideColor.MainText)
urlBox.Text = state.url
urlBox.ClearTextOnFocus = false
urlBox.LayoutOrder = 2
urlBox.Parent = background

local urlCorner = Instance.new("UICorner")
urlCorner.CornerRadius = UDim.new(0, 4)
urlCorner.Parent = urlBox

urlBox.FocusLost:Connect(function()
	local text = string.match(urlBox.Text, "^%s*(.-)%s*$") or ""
	text = string.gsub(text, "/+$", "")
	if text == "" then
		text = DEFAULT_URL
	end
	state.url = text
	urlBox.Text = text
	plugin:SetSetting("BridgeUrl", text)
end)

local connectButton
connectButton = makeButton("Connect", 3, function()
	if state.connected then
		disconnect()
	else
		connect()
	end
end)

makeButton("Sync now", 4, function()
	if not state.connected then
		logWarn("Connect first")
		return
	end
	task.spawn(syncOnce)
end)

makeButton("Pull Studio edits to disk", 5, function()
	if not state.connected then
		logWarn("Connect first")
		return
	end
	task.spawn(pullFromStudio)
end)

local logFrame = Instance.new("ScrollingFrame")
logFrame.Size = UDim2.new(1, 0, 1, -128)
logFrame.BackgroundColor3 = themeColor(Enum.StudioStyleGuideColor.ScrollBarBackground)
logFrame.BorderSizePixel = 0
logFrame.CanvasSize = UDim2.new()
logFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y
logFrame.ScrollBarThickness = 6
logFrame.LayoutOrder = 6
logFrame.Parent = background

local logLayout = Instance.new("UIListLayout")
logLayout.SortOrder = Enum.SortOrder.LayoutOrder
logLayout.Parent = logFrame

local logLabels: { TextLabel } = {}
local logOrder = 0

local function renderLine(line: string)
	logOrder += 1

	local label = Instance.new("TextLabel")
	label.Size = UDim2.new(1, -8, 0, 0)
	label.AutomaticSize = Enum.AutomaticSize.Y
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.Code
	label.TextSize = 13
	label.TextWrapped = true
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextColor3 = if string.sub(line, 1, 1) == "!"
		then themeColor(Enum.StudioStyleGuideColor.WarningText)
		else themeColor(Enum.StudioStyleGuideColor.DimmedText)
	label.Text = line
	label.LayoutOrder = logOrder
	label.Parent = logFrame

	table.insert(logLabels, label)
	while #logLabels > MAX_LOG_LINES do
		local oldest = table.remove(logLabels, 1)
		if oldest then
			oldest:Destroy()
		end
	end

	logFrame.CanvasPosition = Vector2.new(0, logFrame.AbsoluteCanvasSize.Y)
end

logChanged = renderLine

for _, line in pendingLog do
	renderLine(line)
end
table.clear(pendingLog)

setStatus = function(status: string)
	state.status = status
	statusLabel.Text = status
	statusLabel.TextColor3 = if status == "Connected"
		then Color3.fromRGB(102, 187, 106)
		else themeColor(Enum.StudioStyleGuideColor.MainText)
	connectButton.Text = if state.connected then "Disconnect" else "Connect"
end

toggleButton.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	toggleButton:SetActive(widget.Enabled)
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	toggleButton:SetActive(widget.Enabled)
end)

--------------------------------------------------------------------------------
-- Start-up
--------------------------------------------------------------------------------

local savedUrl = plugin:GetSetting("BridgeUrl")
if type(savedUrl) == "string" and savedUrl ~= "" then
	state.url = savedUrl
	urlBox.Text = savedUrl
end

setStatus("Disconnected")
logInfo("Bridge plugin loaded. Run: node server/bridge.js serve")

plugin.Unloading:Connect(function()
	disconnect()
end)
