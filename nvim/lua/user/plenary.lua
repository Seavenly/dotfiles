local status_ok, plenary = pcall(require, "plenary")
if not status_ok then
	return
end

plenary.filetype.add_file("svelte")
