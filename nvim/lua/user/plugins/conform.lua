return {
    'stevearc/conform.nvim',
    event = { "BufWritePre" },
    cmd = { "ConformInfo" },
    opts = {
        formatters_by_ft = {
            javascript = { { "prettierd", "prettier" } },
            javascriptreact = { { "prettierd", "prettier" } },
            typescript = { { "prettierd", "prettier" } },
            typescriptreact = { { "prettierd", "prettier" } },
            css = { { "prettierd", "prettier" } },
            scss = { { "prettierd", "prettier" } },
            html = { { "prettierd", "prettier" } },
            markdown = { { "prettierd", "prettier" } },
            json = { { "prettierd", "prettier" } }
        },
        format_on_save = {
            -- These options will be passed to conform.format()
            timeout_ms = 500,
            lsp_fallback = true,
        },
        formatters = {
            prettierd = {
                env = {
                    PRETTIERD_DEFAULT_CONFIG = vim.fn.expand('~/.config/nvim/lua/user/plugins/.prettierrc.json'),
                }
            }
        }
    },
    init = function()
        -- Manual Format command
        vim.api.nvim_create_user_command("Format", function(args)
            local conform = require "conform"
            local range = nil

            if args.count ~= -1 then
                local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
                range = {
                    start = { args.line1, 0 },
                    ["end"] = { args.line2, end_line:len() },
                }
            end

            conform.format({ async = true, lsp_fallback = true, range = range })
        end, { range = true })
    end
}
