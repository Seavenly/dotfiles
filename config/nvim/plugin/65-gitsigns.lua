vim.pack.add({ 'https://github.com/lewis6991/gitsigns.nvim' })

require('gitsigns').setup({
    signs = {
        add = { text = "▎" },
        change = { text = "▎" },
        delete = { text = "" },
        topdelete = { text = "" },
        changedelete = { text = "▎" },
    },
    signcolumn = true,
    numhl = false,
    linehl = false,
    word_diff = false,
    watch_gitdir = {
        interval = 1000,
        follow_files = true,
    },
    attach_to_untracked = true,
    current_line_blame = false,
    current_line_blame_opts = {
        virt_text = true,
        virt_text_pos = "eol",
        delay = 1000,
        ignore_whitespace = false,
    },
    sign_priority = 6,
    update_debounce = 100,
    status_formatter = nil,
    max_file_length = 40000,
    preview_config = {
        border = "single",
        style = "minimal",
        relative = "cursor",
        row = 0,
        col = 1,
    },
    on_attach = function(bufnr)
        local gs = require('gitsigns')
        local utils = require('user.utils')

        local expr_keys = {
            {
                ']c',
                function()
                    if vim.wo.diff then return ']c' end
                    vim.schedule(function() gs.next_hunk() end)
                    return '<Ignore>'
                end,
                desc = 'Go to next git change',
            },
            {
                '[c',
                function()
                    if vim.wo.diff then return '[c' end
                    vim.schedule(function() gs.prev_hunk() end)
                    return '<Ignore>'
                end,
                desc = 'Go to previous git change',
            },
        }

        utils.set_keys(expr_keys, { buffer = bufnr, expr = true })

        local buffer_keys = {
            { '<leader>hs', function() gs.stage_hunk { vim.fn.line '.', vim.fn.line 'v' } end, desc = 'Stage git hunk',              mode = 'v' },
            { '<leader>hr', function() gs.reset_hunk { vim.fn.line '.', vim.fn.line 'v' } end, desc = 'Reset git hunk',              mode = 'v' },
            { '<leader>hs', gs.stage_hunk,                                                     desc = 'Git stage hunk' },
            { '<leader>hr', gs.reset_hunk,                                                     desc = 'Git reset hunk' },
            { '<leader>hS', gs.stage_buffer,                                                   desc = 'Git stage buffer' },
            { '<leader>hu', gs.stage_hunk,                                                     desc = 'Toggle stage on hunk' },
            { '<leader>hR', gs.reset_buffer,                                                   desc = 'Git reset buffer' },
            { '<leader>hp', gs.preview_hunk,                                                   desc = 'Preview git hunk' },
            { '<leader>hb', function() gs.blame_line { full = false } end,                     desc = 'Git blame line' },
            { '<leader>hd', gs.diffthis,                                                       desc = 'Git diff against index' },
            { '<leader>hD', function() gs.diffthis '~' end,                                    desc = 'Git diff against last commit' },
            { 'ih',         ':<C-U>Gitsigns select_hunk<CR>',                                  desc = 'Select git hunk',             mode = { 'o', 'x' } },
        }

        utils.set_keys(buffer_keys, { buffer = bufnr })
    end,
})

-- status char -> highlight (shared with mini.files palette / gitsigns groups)
local review_status_hl = {
    A = 'GitSignsAdd', M = 'GitSignsChange', D = 'GitSignsDelete',
    R = 'GitSignsChange', C = 'GitSignsChange', T = 'GitSignsChange',
}

-- Fallback for files ADDED relative to the review base. gitsigns can't show
-- these: when a file is absent at the base revision, `git ls-tree <base>` finds
-- no blob, so Obj:refresh() keeps the stale HEAD blob and diffs the file against
-- itself (0 hunks). We detect added-vs-base files and paint the whole buffer
-- green ourselves so newly-added files read like adds during review.
local ns_added = vim.api.nvim_create_namespace('gitsigns_review_added')

local function paint_added(buf)
    local base = vim.g.mini_files_git_base
    if not base or base == '' then return end
    if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= '' then return end
    local name = vim.api.nvim_buf_get_name(buf)
    if name == '' or vim.fn.filereadable(name) ~= 1 then return end

    vim.system({ 'git', '-C', vim.fs.dirname(name), 'diff', '--name-status', base, '--', name },
        { text = true }, function(res)
            local st = (res.stdout or ''):sub(1, 1)
            vim.schedule(function()
                if not vim.api.nvim_buf_is_valid(buf) then return end
                vim.api.nvim_buf_clear_namespace(buf, ns_added, 0, -1)
                if st ~= 'A' then return end
                for i = 0, vim.api.nvim_buf_line_count(buf) - 1 do
                    vim.api.nvim_buf_set_extmark(buf, ns_added, i, 0, {
                        line_hl_group = 'GitSignsAddLn',
                        sign_text = '▎',
                        sign_hl_group = 'GitSignsAdd',
                    })
                end
            end)
        end)
end

local function paint_all_added()
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) then paint_added(b) end
    end
end

vim.api.nvim_create_autocmd({ 'BufWinEnter', 'BufReadPost' }, {
    group = vim.api.nvim_create_augroup('GitsignsReviewAdded', { clear = true }),
    callback = function(args) paint_added(args.buf) end,
})

-- Snacks picker: files changed vs the active review base, rendered as a
-- directory tree (filenames nested under their folders, not full paths).
-- Preview is the per-file diff against the base (shows +/- inherently, and
-- works for deleted files too, unlike a plain file preview).
local function open_review_files()
    local base = vim.g.mini_files_git_base
    if not base or base == '' then
        vim.notify('No review base. Run :GitsignsReviewBase first.', vim.log.levels.WARN)
        return
    end
    local ok, Snacks = pcall(require, 'snacks')
    if not ok then
        vim.notify('snacks.nvim not available', vim.log.levels.ERROR)
        return
    end
    local root = vim.trim(vim.fn.system({ 'git', 'rev-parse', '--show-toplevel' }))
    if vim.v.shell_error ~= 0 or root == '' then
        vim.notify('Not in a git repo', vim.log.levels.ERROR)
        return
    end

    -- Build a directory tree of changed files, mirroring how the Snacks
    -- explorer orders/marks nodes: each item gets a hierarchical `sort` string
    -- ("!" for dirs, "#" for files so dirs sort first at each level) and a
    -- `last` flag (the max-sort child of each parent) for the tree connectors.
    local root_node = { dir = true, sort = '' } -- parent sentinel, not rendered
    local dirs = { [''] = root_node }
    local last = {}
    local items = {}

    local function track_last(item)
        local p = item.parent
        if not last[p] or last[p].sort < item.sort then
            if last[p] then last[p].last = false end
            item.last = true
            last[p] = item
        end
    end

    local function ensure_dir(path)
        if dirs[path] then return dirs[path] end
        local parent_path, base_name = path:match('^(.*)/([^/]+)$')
        if not parent_path then parent_path, base_name = '', path end
        local parent = ensure_dir(parent_path)
        local item = { dir = true, open = true, name = base_name, text = path, parent = parent }
        item.sort = parent.sort .. '!' .. base_name .. ' '
        dirs[path] = item
        items[#items + 1] = item
        track_last(item)
        return item
    end

    for _, line in ipairs(vim.fn.systemlist({ 'git', '-C', root, 'diff', '--name-status', base, '--' })) do
        local parts = vim.split(line, '\t', { plain = true })
        local st = parts[1]:sub(1, 1)
        local rel = (st == 'R' or st == 'C') and parts[3] or parts[2]
        if rel and rel ~= '' then
            local dir_path, base_name = rel:match('^(.*)/([^/]+)$')
            if not dir_path then dir_path, base_name = '', rel end
            local parent = ensure_dir(dir_path)
            -- file is RELATIVE to cwd: Snacks joins them (cwd .. "/" .. file).
            local item = { name = base_name, text = rel, file = rel, cwd = root, st = st, parent = parent }
            item.sort = parent.sort .. '#' .. base_name .. ' '
            items[#items + 1] = item
            track_last(item)
        end
    end
    if #items == 0 then
        vim.notify('No changed files vs ' .. base, vim.log.levels.INFO)
        return
    end

    local fmt = require('snacks.picker.format')
    local preview = require('snacks.picker.preview')

    -- Move the cursor by `step` rows, skipping directory rows so navigation
    -- only ever lands on files (folders stay as visual grounding). Restores the
    -- original position if there's no file in that direction.
    local function skip_dirs(picker, step)
        local list = picker.list
        local n = list:count()
        if n == 0 then return end
        local start = list.cursor
        for _ = 1, n do
            list:move(step)
            local item = picker:current()
            if not item or not item.dir then return end
        end
        list:move(start, true) -- no file that way; stay put
    end

    Snacks.picker.pick({
        title = 'Review · changed files',
        items = items,
        cwd = root,
        sort = { fields = { 'sort' } }, -- preserve hierarchical tree order
        -- Override the movement actions so every key bound to them (j/k, arrows,
        -- <C-n>/<C-p>) skips folders. opts.actions wins over the builtins.
        actions = {
            list_down = function(picker) skip_dirs(picker, 1) end,
            list_up = function(picker) skip_dirs(picker, -1) end,
        },
        on_show = function(picker)
            vim.schedule(function()
                if picker:current() and picker:current().dir then skip_dirs(picker, 1) end
            end)
        end,
        format = function(item, picker)
            local ret = fmt.tree(item, picker) -- indentation + connectors
            if item.dir then
                ret[#ret + 1] = { picker.opts.icons.files.dir_open .. ' ', 'SnacksPickerDirectory' }
                ret[#ret + 1] = { item.name, 'SnacksPickerDirectory' }
            else
                ret[#ret + 1] = { item.st .. ' ', review_status_hl[item.st] or 'Comment' }
                local icon, hl = Snacks.util.icon(item.name, 'file')
                ret[#ret + 1] = { icon .. ' ', hl }
                ret[#ret + 1] = { item.name, 'SnacksPickerFile' }
            end
            return ret
        end,
        preview = function(ctx)
            if ctx.item.dir then return end
            return preview.cmd({ 'git', '--no-pager', 'diff', base, '--', ctx.item.file }, ctx, { ft = 'diff' })
        end,
        confirm = function(picker, item, action)
            if not item or item.dir then return end -- folders are not jump targets
            return require('snacks.picker.actions').jump(picker, item, action)
        end,
    })
end

-- PR review: rebase ALL gitsigns buffers against the merge-base with a ref
-- (defaults to origin/main), matching the diff GitHub shows for the PR.
-- Uses local refs and opens instantly; add ! to fetch origin first (slower).
-- Usage: :GitsignsReviewBase            (uses origin/main, no fetch)
--        :GitsignsReviewBase!           (fetch origin, then origin/main)
--        :GitsignsReviewBase origin/develop
local function review_base(target)
    vim.system({ 'git', 'merge-base', 'HEAD', target }, {}, function(mb)
        local base = vim.trim(mb.stdout or '')
        vim.schedule(function()
            if base == '' then
                vim.notify('No merge-base with ' .. target, vim.log.levels.ERROR)
                return
            end
            local gs = require('gitsigns')
            gs.change_base(base, true)   -- global = true
            gs.toggle_linehl(true)       -- highlight changed lines
            gs.toggle_deleted(true)      -- show removed lines inline
            vim.g.mini_files_git_base = base -- share base with mini.files decorations
            if _G.MiniFilesGitRefresh then _G.MiniFilesGitRefresh() end
            paint_all_added()            -- green fallback for added-vs-base files
            open_review_files()          -- Snacks picker of changed files
            vim.notify('Gitsigns review view → merge-base with ' .. target)
        end)
    end)
end

vim.api.nvim_create_user_command('GitsignsReviewBase', function(opts)
    local target = opts.args ~= '' and opts.args or 'origin/main'
    if opts.bang then
        vim.notify('Fetching origin …')
        vim.system({ 'git', 'fetch', 'origin' }, {}, function() review_base(target) end)
    else
        review_base(target)
    end
end, { nargs = '?', bang = true, desc = 'Set gitsigns base to merge-base for PR review' })

-- Reopen the changed-files picker for the current review base.
vim.api.nvim_create_user_command('GitsignsReviewFiles', open_review_files,
    { desc = 'Snacks picker of files changed vs the review base' })

-- Reset gitsigns back to the default base (index/HEAD) across all buffers.
vim.api.nvim_create_user_command('GitsignsReviewReset', function()
    local gs = require('gitsigns')
    gs.change_base(nil, true)  -- global = true
    gs.toggle_linehl(false)
    gs.toggle_deleted(false)
    vim.g.mini_files_git_base = nil -- back to working-tree status in mini.files
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_valid(b) then vim.api.nvim_buf_clear_namespace(b, ns_added, 0, -1) end
    end
    if _G.MiniFilesGitRefresh then _G.MiniFilesGitRefresh() end
    vim.notify('Gitsigns base → index (HEAD)')
end, { desc = 'Reset gitsigns base after PR review' })

-- Review keymaps, in the <leader>g (git) group alongside the Snacks git maps.
require('user.utils').set_keys({
    { '<leader>gv', '<cmd>GitsignsReviewBase<cr>',  desc = 'Git Review: base = merge-base' },
    { '<leader>gc', '<cmd>GitsignsReviewFiles<cr>', desc = 'Git Review: changed files' },
    { '<leader>gV', '<cmd>GitsignsReviewReset<cr>', desc = 'Git Review: reset base' },
}, {})
