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
    kmap('n', '<S-l>', ':bnext<CR>', 'Navigate to next buffer')
    kmap('n', '<S-h>', ':bprevious<CR>', 'Navigate to previous buffer')
    -- Window resize
    kmap('n', '<C-Up>', ':resize -2<CR>', 'Resize window up')
    kmap('n', '<C-Down>', ':resize +2<CR>', 'Resize window down')
    kmap('n', '<C-Left>', ':vertical resize -2<CR>', 'Resize window left')
    kmap('n', '<C-Right>', ':vertical resize +2<CR>', 'Resize window right')
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
    kmap('n', '<leader>e', '<cmd>NvimTreeToggle<CR>', 'File Explorer')
    kmap('n', '<leader>x', '<cmd>Bdelete!<CR>', 'Close Buffer')
    kmap('n', '<leader>w', '<cmd>w!<CR>', 'Save')
    kmap('n', '<leader>h', '<cmd>nohlsearch<CR>', 'No Highlight')
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
    kmap('n', 'h', api.node.navigate.parent_close, 'Close Node')
  end,

  lsp = function(bufnr)
    local builtin = require 'telescope.builtin'
    local trouble = require "trouble"

    local kmap = opts({ buffer = bufnr, silent = true })

    -- Diagnostics keymaps
    kmap('n', '[d', function() vim.diagnostic.goto_prev({ border = 'rounded' }) end, 'Go to previous diagnostic message')
    kmap('n', ']d', function() vim.diagnostic.goto_next({ border = 'rounded' }) end, 'Go to next diagnostic message')
    kmap('n', '<leader>f', function() vim.diagnostic.open_float({ border = 'rounded', source = true }) end,
      'Open floating diagnostic message')
    kmap('n', '<leader>q', function() trouble.toggle("document_diagnostics") end, 'Open diagnostics list')

    -- LSP keymaps
    kmap('n', 'gd', builtin.lsp_definitions, '[G]oto [D]efinition')
    kmap('n', 'gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
    kmap('n', 'gr', builtin.lsp_references, '[G]oto [R]eferences')
    kmap('n', 'gi', builtin.lsp_implementations, '[G]oto [I]mplementations')
    kmap('n', 'gt', builtin.lsp_type_definitions, '[G]oto [T]ype Definition')
    kmap('n', 'gs', builtin.lsp_document_symbols, '[G]oto Document [S]ymbols')
    kmap('n', 'gw', builtin.lsp_dynamic_workspace_symbols, '[G]oto [W]orkspace Symbols')
    -- Hover
    kmap('n', 'K', vim.lsp.buf.hover, 'Hover documentation')
    kmap('n', '<C-k>', vim.lsp.buf.signature_help, 'Signature documentation')

    kmap('n', '<leader>rn', vim.lsp.buf.rename, '[R]e[n]ame')
    kmap('n', '<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ctions')
  end
}

Keymaps.static()

return Keymaps
