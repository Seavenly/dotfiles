local function opts(default)
  return function(mode, keys, command, desc)
    local default_copy = vim.deepcopy(default)
    local desc_prefix = default_copy.desc or ""

    default_copy.desc = desc_prefix .. desc

    vim.keymap.set(mode, keys, command, default_copy)
  end
end

-- Telescope live_grep in git root
-- Function to find the git root directory based on the current buffer's path
local function find_git_root()
  -- Use the current buffer's path as the starting point for the git search
  local current_file = vim.api.nvim_buf_get_name(0)
  local current_dir
  local cwd = vim.fn.getcwd()
  -- If the buffer is not associated with a file, return nil
  if current_file == '' then
    current_dir = cwd
  else
    -- Extract the directory from the current file's path
    current_dir = vim.fn.fnamemodify(current_file, ':h')
  end

  -- Find the Git root directory from the current file's path
  local git_root = vim.fn.systemlist('git -C ' ..
    vim.fn.escape(current_dir, ' ') .. ' rev-parse --show-toplevel')[1]
  if vim.v.shell_error ~= 0 then
    print 'Not a git repository. Searching on current working directory'
    return cwd
  end
  return git_root
end

local Keymaps = {
  static = function()
    local kmap = opts({ silent = true })

    --Remap space as leader key
    vim.g.mapleader = ' '
    vim.g.maplocalleader = ' '

    kmap({ 'n', 'v' }, '<Space>', '<Nop>', 'Space character noop')
    -- Window navigation
    kmap('n', '<C-h>', '<C-w>h', 'Navigate to window left')
    kmap('n', '<C-j>', '<C-w>j', 'Navigate to window down')
    kmap('n', '<C-k>', '<C-w>k', 'Navigate to window up')
    kmap('n', '<C-l>', '<C-w>l', 'Navigate to window right')
    -- Buffer navigation
    kmap('n', 'L', ':bnext<CR>', 'Navigate to next buffer')
    kmap('n', 'H', ':bprevious<CR>', 'Navigate to previous buffer')
    -- Window resize
    kmap('n', '<A-Up>', ':resize -2<CR>', 'Resize window up')
    kmap('n', '<A-Down>', ':resize +2<CR>', 'Resize window down')
    kmap('n', '<A-Left>', ':vertical resize -2<CR>', 'Resize window left')
    kmap('n', '<A-Right>', ':vertical resize +2<CR>', 'Resize window right')
    -- Scrolling
    kmap('n', '<C-u>', '<C-u>zz', 'Scroll half-page up and center on cursor')
    kmap('n', '<C-d>', '<C-d>zz', 'Scroll half-page down and center on cursor')
    -- Move text up and down
    kmap('n', '<A-k>', '<Esc>:m .-2<CR>==gi', 'Move line up and enter insert mode')
    kmap('n', '<A-j>', '<Esc>:m .+1<CR>==gi', 'Move line down and enter insert mode')
    kmap('v', '<A-j>', ':m .+1<CR>==', 'Move line down')
    kmap('v', '<A-k>', ':m .-2<CR>==', 'Move line up')
    kmap('x', 'J', ':move \'>+1<CR>gv-gv', 'Move line down')
    kmap('x', 'K', ':move \'<-2<CR>gv-gv', 'Move line up')
    kmap('x', '<A-j>', ':move \'>+1<CR>gv-gv', 'Move like down')
    kmap('x', '<A-k>', ':move \'<-2<CR>gv-gv', 'Move line up')
    -- Stay in indent mode
    kmap('v', '<', '<gv', 'Indent right and keep selection')
    kmap('v', '>', '>gv', 'Indent left and keep selection')
    -- Other
    kmap('v', 'p', '"_dP', 'Paste and keep previous yank on clipboard')
    -- Global leader commands
    kmap('n', '<leader>e', ':NvimTreeToggle<CR>', 'File Explorer')
    kmap('n', '<leader>x', ':Bdelete!<CR>', 'Close Buffer')
    kmap('n', '<leader>w', ':w!<CR>', 'Save')
    kmap('n', '<leader>h', ':nohlsearch<CR>', 'No Highlight')
  end,

  telescope = function()
    local builtin = require 'telescope.builtin'

    local kmap = opts({ silent = true })

    local function live_grep_git_root()
      local git_root = find_git_root()
      if git_root then
        builtin.live_grep {
          search_dirs = { git_root },
        }
      end
    end

    local function live_grep_open_files()
      builtin.live_grep {
        grep_open_files = true,
        prompt_title = 'Live Grep in Open Files',
      }
    end

    kmap('n', '<leader>?', builtin.oldfiles, '[?] Find recently opened files')
    kmap('n', '<leader><space>', builtin.buffers, '[ ] Find existing buffers')
    kmap('n', '<leader>/', builtin.current_buffer_fuzzy_find, '[/] Fuzzily search in current buffer')
    kmap('n', '<leader>s/', live_grep_open_files, '[S]earch [/] in Open Files')
    kmap('n', '<leader>ss', builtin.builtin, '[S]earch [S]elect Telescope')
    kmap('n', '<leader>sg', builtin.git_files, '[S]earch [G]it Files')
    kmap('n', '<leader>sG', live_grep_git_root, '[S]earch [G]it Files by Grep')
    kmap('n', '<leader>sf', builtin.find_files, '[S]earch [F]iles')
    kmap('n', '<leader>sF', builtin.live_grep, '[S]earch [F]iles by Grep')
    kmap('n', '<leader>sw', builtin.grep_string, '[S]earch current [W]ord')
    kmap('n', '<leader>sh', builtin.help_tags, '[S]earch [H]elp')
    kmap('n', '<leader>sd', builtin.diagnostics, '[S]earch [D]iagnostics')
    kmap('n', '<leader>sr', builtin.resume, '[S]earch [R]esume')
  end,

  nvim_tree = function(bufnr)
    local api = require "nvim-tree.api"

    local kmap = opts({ desc = "nvim-tree: ", buffer = bufnr, noremap = true, silent = true, nowait = true })

    -- default mappings
    api.config.mappings.default_on_attach(bufnr)
    -- custom mappings
    kmap('n', 'l', api.node.open.edit, 'Edit')
    kmap('n', 'v', api.node.open.vertical, 'Vertical Split')
    kmap('n', 's', api.node.open.horizontal, 'Horizontal Split')
    kmap('n', 'h', api.node.navigate.parent_close, 'Close Node')
  end,

  lsp = function(bufnr)
    local trouble = require "trouble"
    local builtin = require "telescope.builtin"

    local kmap = opts({ buffer = bufnr, silent = true })

    -- Diagnostics keymaps
    kmap('n', '[d', function() vim.diagnostic.goto_prev({ border = 'rounded' }) end, 'Go to previous diagnostic message')
    kmap('n', ']d', function() vim.diagnostic.goto_next({ border = 'rounded' }) end, 'Go to next diagnostic message')
    kmap('n', '<leader>f', function() vim.diagnostic.open_float({ border = 'rounded', source = true }) end,
      'Open floating diagnostic message')
    kmap('n', '<leader>ld', function() trouble.toggle('document_diagnostics') end, '[L]SP: Document [D]iagnostics')
    kmap('n', '<leader>lD', function() trouble.toggle('workspace_diagnostics') end, '[L]SP: Workspace [D]iagnostics')
    kmap('n', '<leader>lr', vim.lsp.buf.rename, '[L]SP: [R]ename')
    kmap('n', '<leader>la', vim.lsp.buf.code_action, '[L]SP: Code [A]ctions')
    kmap('n', '<leader>ls', builtin.lsp_document_symbols, '[L]SP: Search Document [S]ymbols')
    kmap('n', '<leader>lS', builtin.lsp_dynamic_workspace_symbols, '[L]SP: Search Workspace [S]ymbols')
    -- Non-leader keymaps
    kmap('n', 'gd', function() trouble.toggle('lsp_definitions') end, '[G]oto [D]efinition')
    kmap('n', 'gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
    kmap('n', 'gr', function() trouble.toggle('lsp_references') end, '[G]oto [R]eferences')
    kmap('n', 'gi', function() trouble.toggle('lsp_implementations') end, '[G]oto [I]mplementations')
    kmap('n', 'gt', function() trouble.toggle('lsp_type_definitions') end, '[G]oto [T]ype Definition')
    -- Hover
    kmap('n', 'K', vim.lsp.buf.hover, 'Hover documentation')
    kmap('n', '<C-k>', vim.lsp.buf.signature_help, 'Signature documentation')
  end,

  gitsigns = function(bufnr)
    local gs = require "gitsigns"

    local kmap = opts({ buffer = bufnr, expr = true })

    -- Navigation
    kmap('n', ']c', function()
      if vim.wo.diff then return ']c' end
      vim.schedule(function() gs.next_hunk() end)
      return '<Ignore>'
    end, 'Go to next git change')

    kmap('n', '[c', function()
      if vim.wo.diff then return '[c' end
      vim.schedule(function() gs.prev_hunk() end)
      return '<Ignore>'
    end, 'Go to previous git change')

    kmap = opts({ buffer = bufnr })

    kmap('v', '<leader>hs', function() gs.stage_hunk { vim.fn.line '.', vim.fn.line 'v' } end, 'Stage git hunk')
    kmap('v', '<leader>hr', function() gs.reset_hunk { vim.fn.line '.', vim.fn.line 'v' } end, 'Reset git hunk')
    -- normal mode
    kmap('n', '<leader>hs', gs.stage_hunk, 'Git stage hunk')
    kmap('n', '<leader>hr', gs.reset_hunk, 'Git reset hunk')
    kmap('n', '<leader>hS', gs.stage_buffer, 'Git stage buffer')
    kmap('n', '<leader>hu', gs.undo_stage_hunk, 'Undo stage hunk')
    kmap('n', '<leader>hR', gs.reset_buffer, 'Git reset buffer')
    kmap('n', '<leader>hp', gs.preview_hunk, 'Preview git hunk')
    kmap('n', '<leader>hb', function() gs.blame_line { full = false } end, 'Git blame line')
    kmap('n', '<leader>hd', gs.diffthis, 'Git diff against index')
    kmap('n', '<leader>hD', function() gs.diffthis '~' end, 'Git diff against last commit')
    -- Text object
    kmap({ 'o', 'x' }, 'ih', ':<C-U>Gitsigns select_hunk<CR>', 'Select git hunk')
  end,

  obsidian = function()
    local kmap = opts({ silent = true })

    kmap('n', '<leader>oo', ':ObsidianOpen<CR>', '[O]bsidian [O]pen in App')
    kmap('n', '<leader>ot', ':ObsidianTags<CR>', '[O]bsidian [T]ags')
    kmap('n', '<leader>od', ':ObsidianDailies<CR>', '[O]bsidian [D]ailies')
    kmap('n', '<leader>ol', ':ObsidianLinks<CR>', '[O]bsidian [L]inks')
    kmap('n', '<leader>ob', ':ObsidianBacklinks<CR>', '[O]bsidian [B]acklinks')
    kmap('n', '<leader>on', ':ObsidianNew<CR>', '[O]bsidian [N]ew Note')
    kmap('n', '<leader>oy', ':ObsidianToday<CR>', '[O]bsidian Toda[y]')
    kmap('n', '<leader>op', ':ObsidianPasteImg<CR>', '[O]bsidian [P]aste Image')
    kmap('n', '<leader>oc', function() return require("obsidian").util.toggle_checkbox() end,
      '[O]bsidian [C]heckbox Toggle')
    -- Search Keymap
    kmap('n', '<leader>so', ':ObsidianSearch<CR>', '[S]earch [O]bsidian')
    -- Visual Mode Selection Keymaps
    kmap('v', '<leader>oe', ":ObsidianExtractNote<CR>", '[O]bsidian [E]xtract Note')
    kmap('v', '<leader>ol', ":ObsidianLink<CR>", '[O]bsidian [L]ink')
    kmap('v', '<leader>on', ":ObsidianLinkNew<CR>", '[O]bsidian Link [N]ew')
  end
}

Keymaps.static()

return Keymaps
