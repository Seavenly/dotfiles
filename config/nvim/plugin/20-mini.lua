vim.pack.add({ 'https://github.com/nvim-mini/mini.nvim' })

local mini_ai = require('mini.ai')
mini_ai.setup({
    mappings = {
        around = 'a',
        inside = 'i',
        around_next = 'an',
        inside_next = 'in',
        around_last = 'al',
        inside_last = 'il',
        goto_left = 'g[',
        goto_right = 'g]',
    },
    n_lines = 50,
    search_method = 'cover_or_next',
    silent = false,
    custom_textobjects = {
        F = mini_ai.gen_spec.treesitter({ a = '@function.outer', i = '@function.inner' }),
    },
})

require('mini.comment').setup({
    options = {
        custom_commentstring = nil,
        ignore_blank_line = false,
        start_of_line = false,
        pad_comment_parts = true,
    },
    mappings = {
        comment = 'gc',
        comment_line = 'gcc',
        comment_visual = 'gc',
        textobject = 'gc',
    },
    hooks = {
        pre = function() end,
        post = function() end,
    },
})

require('mini.files').setup({
    content = {
        filter = nil,
        prefix = nil,
        sort = nil,
    },
    mappings = {
        close       = 'q',
        go_in       = 'l',
        go_in_plus  = '<CR>',
        go_out      = 'h',
        go_out_plus = '<BS>',
        mark_goto   = "'",
        mark_set    = 'm',
        reset       = '<DEL>',
        reveal_cwd  = '@',
        show_help   = 'g?',
        synchronize = '=',
        trim_left   = '<',
        trim_right  = '>',
    },
    options = {
        permanent_delete = true,
        use_as_default_explorer = true,
    },
    windows = {
        max_number = math.huge,
        preview = false,
        width_focus = 50,
        width_nofocus = 15,
        width_preview = 25,
    },
})

require('user.utils').set_keys({
    { '<leader>e', function() MiniFiles.open() end, desc = "File Explorer" },
    {
        '<leader>E',
        function()
            MiniFiles.open(vim.api.nvim_buf_get_name(0))
            MiniFiles.reveal_cwd()
        end,
        desc = "File Explorer (current buffer)",
    },
}, { silent = true })

require('mini.pairs').setup({
    modes = { insert = true, command = false, terminal = false },
    mappings = {
        ['('] = { action = 'open', pair = '()', neigh_pattern = '[^\\].' },
        ['['] = { action = 'open', pair = '[]', neigh_pattern = '[^\\].' },
        ['{'] = { action = 'open', pair = '{}', neigh_pattern = '[^\\].' },
        [')'] = { action = 'close', pair = '()', neigh_pattern = '[^\\].' },
        [']'] = { action = 'close', pair = '[]', neigh_pattern = '[^\\].' },
        ['}'] = { action = 'close', pair = '{}', neigh_pattern = '[^\\].' },
        ['"'] = { action = 'closeopen', pair = '""', neigh_pattern = '[^\\].', register = { cr = false } },
        ["'"] = { action = 'closeopen', pair = "''", neigh_pattern = '[^%a\\].', register = { cr = false } },
        ['`'] = { action = 'closeopen', pair = '``', neigh_pattern = '[^\\].', register = { cr = false } },
    },
})

require('mini.surround').setup({
    custom_surroundings = nil,
    highlight_duration = 500,
    mappings = {
        add = 'sa',
        delete = 'sd',
        find = 'sf',
        find_left = 'sF',
        highlight = 'sh',
        replace = 'sr',
        update_n_lines = 'sn',
        suffix_last = 'l',
        suffix_next = 'n',
    },
    n_lines = 20,
    respect_selection_type = false,
    search_method = 'cover',
    silent = false,
})
