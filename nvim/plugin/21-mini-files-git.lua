-- Git status decorations for mini.files.
-- mini.files has no built-in git support, but exposes User autocmd events we
-- can hook to annotate entries. Colors link to the GitSigns highlight groups
-- so the explorer matches the in-buffer signs.
--
-- When a review base is active (set by :GitsignsReviewBase via the global
-- vim.g.mini_files_git_base), entries are diffed against that base so a
-- checked-out PR's committed changes show up. Otherwise it falls back to
-- working-tree status (git status).

local ns = vim.api.nvim_create_namespace('mini_files_git')

-- Highlight groups, linked to gitsigns' palette (override in a colorscheme).
local links = {
    MiniFilesGitModified  = 'GitSignsChange',
    MiniFilesGitStaged    = 'GitSignsAdd',
    MiniFilesGitUntracked = 'GitSignsAdd',
    MiniFilesGitDeleted   = 'GitSignsDelete',
    MiniFilesGitRenamed   = 'GitSignsChange',
    MiniFilesGitUnmerged  = 'DiagnosticError',
}
for name, link in pairs(links) do
    vim.api.nvim_set_hl(0, name, { link = link, default = true })
end

-- status char -> { symbol, highlight }
local symbols = {
    M = { '●', 'MiniFilesGitModified' },
    A = { '+', 'MiniFilesGitStaged' },
    D = { '✗', 'MiniFilesGitDeleted' },
    R = { '➜', 'MiniFilesGitRenamed' },
    C = { '➜', 'MiniFilesGitRenamed' },
    T = { '●', 'MiniFilesGitModified' },
    U = { '‼', 'MiniFilesGitUnmerged' },
    ['?'] = { '?', 'MiniFilesGitUntracked' },
}

-- Reduce a porcelain XY code to a single representative char.
local function status_char(xy)
    if xy == '??' then return '?' end
    local x, y = xy:sub(1, 1), xy:sub(2, 2)
    for _, c in ipairs({ y, x }) do -- prefer worktree change, then staged
        if c ~= ' ' and c ~= '?' then return c end
    end
    return nil
end

-- Mark ancestor directories of every changed path so folders show a marker.
local function propagate(map, root)
    local extra = {}
    for abs in pairs(map) do
        local d = vim.fs.dirname(abs)
        while d and d ~= root and #d > #root do
            if not map[d] and not extra[d] then extra[d] = 'M' end
            d = vim.fs.dirname(d)
        end
    end
    for d, c in pairs(extra) do map[d] = c end
end

local function parse_status(out, root, map)
    for line in vim.gsplit(out, '\n', { plain = true }) do
        if line ~= '' then
            local xy, rest = line:sub(1, 2), line:sub(4)
            local arrow = rest:find(' %-> ')             -- renames: take the new name
            if arrow then rest = rest:sub(arrow + 4) end
            rest = rest:gsub('^"', ''):gsub('"$', ''):gsub('/$', '')
            local c = status_char(xy)
            if c then map[root .. '/' .. rest] = c end
        end
    end
end

local function parse_diff(out, root, map)
    for line in vim.gsplit(out, '\n', { plain = true }) do
        if line ~= '' then
            local parts = vim.split(line, '\t', { plain = true })
            local st = parts[1]:sub(1, 1)
            local rel = (st == 'R' or st == 'C') and parts[3] or parts[2]
            if rel and rel ~= '' then map[root .. '/' .. rel] = st end
        end
    end
end

local function apply(buf_id, map)
    if not vim.api.nvim_buf_is_valid(buf_id) then return end
    vim.api.nvim_buf_clear_namespace(buf_id, ns, 0, -1)
    for i = 1, vim.api.nvim_buf_line_count(buf_id) do
        local entry = MiniFiles.get_fs_entry(buf_id, i)
        local code = entry and map[entry.path]
        local sym = code and symbols[code]
        if sym then
            local text = vim.api.nvim_buf_get_lines(buf_id, i - 1, i, false)[1] or ''
            -- right-aligned status symbol
            vim.api.nvim_buf_set_extmark(buf_id, ns, i - 1, 0, {
                virt_text = { { ' ' .. sym[1] .. ' ', sym[2] } },
                virt_text_pos = 'right_align',
                hl_mode = 'combine',
            })
            -- tint the entry name
            local s = text:find(vim.pesc(entry.name), 1, true)
            if s then
                vim.api.nvim_buf_set_extmark(buf_id, ns, i - 1, s - 1, {
                    end_col = #text,
                    hl_group = sym[2],
                    hl_mode = 'combine',
                })
            end
        end
    end
end

local function update(buf_id)
    if not vim.api.nvim_buf_is_valid(buf_id) then return end
    local first = MiniFiles.get_fs_entry(buf_id, 1)
    if not first then return end
    local dir = vim.fs.dirname(first.path)

    vim.system({ 'git', '-C', dir, 'rev-parse', '--show-toplevel' }, { text = true }, function(root_res)
        if root_res.code ~= 0 then return end
        local root = vim.trim(root_res.stdout)

        local base = vim.g.mini_files_git_base
        local reviewing = base ~= nil and base ~= ''
        local cmd = reviewing
            and { 'git', '-C', root, 'diff', '--name-status', base, '--' }
            or { 'git', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all' }

        vim.system(cmd, { text = true }, function(res)
            if res.code ~= 0 then return end
            local map = {}
            if reviewing then
                parse_diff(res.stdout, root, map)
            else
                parse_status(res.stdout, root, map)
            end
            propagate(map, root)
            vim.schedule(function() apply(buf_id, map) end)
        end)
    end)
end

-- Re-decorate any open mini.files buffers (called when the review base flips).
function _G.MiniFilesGitRefresh()
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].filetype == 'minifiles' then
            update(buf)
        end
    end
end

local group = vim.api.nvim_create_augroup('MiniFilesGit', { clear = true })
vim.api.nvim_create_autocmd('User', {
    group = group,
    pattern = { 'MiniFilesBufferCreate', 'MiniFilesBufferUpdate' },
    callback = function(args) update(args.data.buf_id) end,
})
