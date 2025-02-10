return {
    "lewis6991/gitsigns.nvim",
    on_attach = function(bufnr)
        local gs = require "gitsigns"
        local utils = require 'user.utils'

        local expr_keys = {
            -- Navigation
            {
                ']c',
                function()
                    if vim.wo.diff then return ']c' end
                    vim.schedule(function() gs.next_hunk() end)
                    return '<Ignore>'
                end,
                desc = 'Go to next git change'
            },

            {
                '[c',
                function()
                    if vim.wo.diff then return '[c' end
                    vim.schedule(function() gs.prev_hunk() end)
                    return '<Ignore>'
                end,
                desc = 'Go to previous git change'
            }
        }

        utils.set_keys(expr_keys, { buffer = bufnr, expr = true })

        local buffer_keys = {
            { '<leader>hs', function() gs.stage_hunk { vim.fn.line '.', vim.fn.line 'v' } end, desc = 'Stage git hunk',              mode = 'v' },
            { '<leader>hr', function() gs.reset_hunk { vim.fn.line '.', vim.fn.line 'v' } end, desc = 'Reset git hunk',              mode = 'v' },
            -- normal mode
            { '<leader>hs', gs.stage_hunk,                                                     desc = 'Git stage hunk' },
            { '<leader>hr', gs.reset_hunk,                                                     desc = 'Git reset hunk' },
            { '<leader>hS', gs.stage_buffer,                                                   desc = 'Git stage buffer' },
            { '<leader>hu', gs.undo_stage_hunk,                                                desc = 'Undo stage hunk' },
            { '<leader>hR', gs.reset_buffer,                                                   desc = 'Git reset buffer' },
            { '<leader>hp', gs.preview_hunk,                                                   desc = 'Preview git hunk' },
            { '<leader>hb', function() gs.blame_line { full = false } end,                     desc = 'Git blame line' },
            { '<leader>hd', gs.diffthis,                                                       desc = 'Git diff against index' },
            { '<leader>hD', function() gs.diffthis '~' end,                                    desc = 'Git diff against last commit' },
            -- Text object
            { 'ih',         ':<C-U>Gitsigns select_hunk<CR>',                                  desc = 'Select git hunk',             mode = { 'o', 'x' } }
        }

        utils.set_keys(buffer_keys, { buffer = bufnr })
    end,
    opts = {
        signs = {
            add = { text = "▎" },
            change = { text = "▎" },
            delete = { text = "" },
            topdelete = { text = "" },
            changedelete = { text = "▎" },
        },
        signcolumn = true, -- Toggle with `:Gitsigns toggle_signs`
        numhl = false,     -- Toggle with `:Gitsigns toggle_numhl`
        linehl = false,    -- Toggle with `:Gitsigns toggle_linehl`
        word_diff = false, -- Toggle with `:Gitsigns toggle_word_diff`
        watch_gitdir = {
            interval = 1000,
            follow_files = true,
        },
        attach_to_untracked = true,
        current_line_blame = false, -- Toggle with `:Gitsigns toggle_current_line_blame`
        current_line_blame_opts = {
            virt_text = true,
            virt_text_pos = "eol", -- 'eol' | 'overlay' | 'right_align'
            delay = 1000,
            ignore_whitespace = false,
        },
        sign_priority = 6,
        update_debounce = 100,
        status_formatter = nil, -- Use default
        max_file_length = 40000,
        preview_config = {
            -- Options passed to nvim_open_win
            border = "single",
            style = "minimal",
            relative = "cursor",
            row = 0,
            col = 1,
        },
    }
}
