-- events and output are supplied by the Node runner.
local idx = 1
local releases = {}
local dumped = false

emu.register_frame_done(function()
  local now = manager.machine.time:as_double()
  if not dumped then
    for tag, port in pairs(manager.machine.ioport.ports) do
      for name, field in pairs(port.fields) do
        print('PORT ' .. tag .. ' ' .. name)
      end
    end
    dumped = true
  end
  for i = #releases, 1, -1 do
    local release = releases[i]
    if now >= release.at then
      release.field:set_value(0)
      table.remove(releases, i)
    end
  end
  while idx <= #events and now >= events[idx].at do
    local event = events[idx]
    print('EVENT ' .. idx .. ' ' .. now)
    if event.capture then
      local count = 0
      for tag, screen in pairs(manager.machine.screens) do
        count = count + 1
        screen:snapshot(output .. '/' .. event.capture .. '-mame.png')
        print('CAPTURE ' .. event.capture .. ' ' .. tag .. ' ' .. now)
      end
      if count ~= 1 then error('Expected one screen') end
    elseif event.fields then
      for _, name in ipairs(event.fields) do
        local found = 0
        for tag, port in pairs(manager.machine.ioport.ports) do
          for fieldName, field in pairs(port.fields) do
            if fieldName == name then
              field:set_value(1)
              table.insert(releases, { field = field, at = now + 0.15 })
              found = found + 1
            end
          end
        end
        if found ~= 1 then error('Expected one field for ' .. name .. ', found ' .. found) end
      end
    elseif event.key then
      local codes = { Enter = '{ENTER}', Escape = '{ESC}', F9 = '{F9}', Space = ' ' }
      manager.machine.natkeyboard:post_coded(codes[event.key])
    elseif event.boot then
      manager.machine.natkeyboard:post_coded(event.boot)
    elseif event.input then
      manager.machine.natkeyboard:post(event.input .. '\r')
    end
    idx = idx + 1
  end
end)
