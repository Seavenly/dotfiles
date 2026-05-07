vim.pack.add({ 'https://github.com/nvim-treesitter/nvim-treesitter' })

local ensure_installed = {
    "javascript", "lua", "rust", "bash", "comment", "css", "dockerfile", "go", "graphql",
    "html", "jsdoc", "json", "kotlin", "markdown", "markdown_inline", "python", "svelte",
    "scss", "swift", "toml", "typescript", "tsx", "vim", "yaml", "ruby", "hurl", "zig",
    "templ", "regex", "terraform",
}

local installed = require("nvim-treesitter.config").get_installed()
local to_install = vim.iter(ensure_installed)
    :filter(function(p) return not vim.tbl_contains(installed, p) end)
    :totable()
if #to_install > 0 then
    require("nvim-treesitter").install(to_install)
end

vim.api.nvim_create_autocmd("FileType", {
    callback = function(args)
        pcall(vim.treesitter.start, args.buf)
    end,
})
