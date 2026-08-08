-- conform is loaded on first :Format invocation or first BufWritePre, whichever fires first.
local loaded = false
local function load_conform()
    if loaded then return require('conform') end
    loaded = true
    vim.pack.add({ 'https://github.com/stevearc/conform.nvim' })
    require('conform').setup({
        formatters_by_ft = {
            javascript = { "prettierd", "prettier", stop_after_first = true },
            javascriptreact = { "prettierd", "prettier", stop_after_first = true },
            typescript = { "prettierd", "prettier", stop_after_first = true },
            typescriptreact = { "prettierd", "prettier", stop_after_first = true },
            css = { "prettierd", "prettier", stop_after_first = true },
            scss = { "prettierd", "prettier", stop_after_first = true },
            html = { "prettierd", "prettier", stop_after_first = true },
            markdown = { "prettierd", "prettier", stop_after_first = true },
            json = { "prettierd", "prettier", stop_after_first = true },
        },
        format_on_save = function(bufnr)
            if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
                return
            end
            return { timeout_ms = 500, lsp_format = "fallback" }
        end,
        formatters = {
            prettierd = {
                env = {
                    PRETTIERD_DEFAULT_CONFIG = vim.fn.expand('~/.config/nvim/lua/user/.prettierrc.json'),
                },
            },
        },
    })
    return require('conform')
end

vim.api.nvim_create_user_command("Format", function(args)
    local conform = load_conform()
    local range = nil
    if args.count ~= -1 then
        local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
        range = {
            start = { args.line1, 0 },
            ["end"] = { args.line2, end_line:len() },
        }
    end
    conform.format({ async = true, lsp_format = "fallback", range = range })
end, { range = true })

vim.api.nvim_create_user_command("WriteNoFormat", function()
    vim.g.disable_autoformat = true
    vim.cmd("w")
    vim.g.disable_autoformat = false
end, { desc = "Write without formatting" })

-- Defer install + setup to first BufWritePre. Re-emit the event so the
-- triggering save still gets formatted.
vim.api.nvim_create_autocmd('BufWritePre', {
    once = true,
    callback = function()
        load_conform()
        vim.api.nvim_exec_autocmds('BufWritePre', {})
    end,
})
