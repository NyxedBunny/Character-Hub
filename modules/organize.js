// modules/organize.js
// "Carpetas" tab: character folders (ported from CTM, no PIN/private) + native
// SillyTavern tag manager (create/rename/color/delete/merge). No character editing here.
import CoreAPI from './core-api.js';

const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));

// ========================================
// STORAGE — character folders (own extensionSettings key, like any other NX setting)
// ========================================
const FOLDERS_KEY = 'nxFolders'; // array of { id, name, parentId, color, characters: [avatar,...] }

function getFolders() {
    const v = CoreAPI.getSetting(FOLDERS_KEY);
    return Array.isArray(v) ? v : [];
}
function saveFolders(list) {
    CoreAPI.setSetting(FOLDERS_KEY, list);
    // Note: the native #rm_print_characters_block grouping lives in index.js
    // now and reads this same extensionSettings key directly on its own
    // MutationObserver/interval — no explicit refresh call needed from here.
}
function genId() {
    return 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function findFolder(id) {
    return getFolders().find(f => f.id === id) || null;
}
function childrenOf(parentId) {
    return getFolders().filter(f => (f.parentId || null) === (parentId || null));
}
function descendantIds(id) {
    const out = [id];
    let changed = true;
    while (changed) {
        changed = false;
        for (const f of getFolders()) {
            if (f.parentId && out.includes(f.parentId) && !out.includes(f.id)) {
                out.push(f.id);
                changed = true;
            }
        }
    }
    return out;
}

// ========================================
// STORAGE — native ST tags (live references, same pattern the extension already
// uses elsewhere: getSTContext() + saveSettingsDebounced())
// ========================================
function ctx() {
    return CoreAPI.getSTContext();
}
function getTags() {
    const c = ctx();
    return (c && Array.isArray(c.tags)) ? c.tags : [];
}
function getTagMap() {
    const c = ctx();
    return (c && c.tagMap) ? c.tagMap : {};
}
function persistST() {
    const c = ctx();
    c?.saveSettingsDebounced?.();
}
function tagCharCount(tagId) {
    const map = getTagMap();
    let n = 0;
    for (const avatar in map) {
        if (Array.isArray(map[avatar]) && map[avatar].includes(tagId)) n++;
    }
    return n;
}
function charsForTag(tagId) {
    const map = getTagMap();
    const avatars = Object.keys(map).filter(a => Array.isArray(map[a]) && map[a].includes(tagId));
    return avatars.map(a => CoreAPI.getCharacterByAvatar(a)).filter(Boolean);
}

// ========================================
// STATE
// ========================================
let activeTab = 'folders'; // 'folders' | 'tags'
let activeFolderId = null;
let activeTagId = null;
let searchQuery = '';
let expanded = new Set();

const els = {};

// ========================================
// ACTIVATE (called by switchView('online') via onViewEnter)
// ========================================
function activate() {
    ensureToolbar();
    ensureMainMount();
    render();
}

function ensureToolbar() {
    const host = document.getElementById('onlineFilterContent');
    const providerHost = document.getElementById('providerSelectorArea');
    if (providerHost) providerHost.innerHTML = '';
    if (!host) return;
    if (host.dataset.nxReady === '1') return;
    host.dataset.nxReady = '1';
    host.innerHTML = `
        <div class="nx-organize-toolbar">
            <div class="nx-tabs">
                <button class="nx-tab-btn" data-tab="folders"><i class="fa-solid fa-folder-tree"></i> Carpetas</button>
                <button class="nx-tab-btn" data-tab="tags"><i class="fa-solid fa-tags"></i> Tags</button>
            </div>
            <div class="nx-toolbar-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="search" id="nxOrganizeSearch" placeholder="Buscar..." autocomplete="off">
            </div>
            <button class="cl-btn cl-btn-primary nx-new-btn" id="nxNewBtn">
                <i class="fa-solid fa-plus"></i> <span id="nxNewBtnLabel">Nueva carpeta</span>
            </button>
            <button class="cl-btn cl-btn-secondary nx-import-ctm-btn" id="nxImportCtmBtn" title="Importar carpetas desde Character Tag Manager">
                <i class="fa-solid fa-file-import"></i> Importar de CTM
            </button>
        </div>
    `;
    host.querySelectorAll('.nx-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            activeFolderId = null;
            activeTagId = null;
            searchQuery = '';
            const input = document.getElementById('nxOrganizeSearch');
            if (input) input.value = '';
            render();
        });
    });
    const search = document.getElementById('nxOrganizeSearch');
    search?.addEventListener('input', () => {
        searchQuery = search.value.trim().toLowerCase();
        renderTree();
    });
    document.getElementById('nxNewBtn')?.addEventListener('click', () => {
        if (activeTab === 'folders') createFolderFlow(null);
        else createTagFlow();
    });
    document.getElementById('nxImportCtmBtn')?.addEventListener('click', () => importFromCTMFlow());
}

function ensureMainMount() {
    const view = document.getElementById('onlineView');
    if (!view) return;
    if (view.dataset.nxReady === '1') return;
    view.dataset.nxReady = '1';
    view.classList.add('nx-organize-view');
    view.innerHTML = `
        <div class="nx-organize-layout">
            <div class="nx-organize-tree" id="nxTree"></div>
            <div class="nx-organize-main" id="nxMain"></div>
        </div>
    `;
}

function render() {
    const toolbar = document.getElementById('onlineFilterContent');
    toolbar?.querySelectorAll('.nx-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
    const label = document.getElementById('nxNewBtnLabel');
    if (label) label.textContent = activeTab === 'folders' ? 'Nueva carpeta' : 'Nuevo tag';
    const importBtn = document.getElementById('nxImportCtmBtn');
    if (importBtn) importBtn.style.display = activeTab === 'folders' ? '' : 'none';
    renderTree();
    renderMain();
}

// ========================================
// TREE (left column)
// ========================================
function renderTree() {
    const tree = document.getElementById('nxTree');
    if (!tree) return;
    if (activeTab === 'folders') tree.innerHTML = renderFolderTree();
    else tree.innerHTML = renderTagList();
    wireTreeEvents(tree);
}

function renderFolderTree() {
    const all = getFolders();
    const q = searchQuery;
    const matches = q ? all.filter(f => f.name.toLowerCase().includes(q)) : null;

    function rowHtml(f, depth) {
        const kids = childrenOf(f.id);
        const hasKids = kids.length > 0;
        const isExpanded = expanded.has(f.id);
        const count = f.characters?.length || 0;
        const active = activeFolderId === f.id ? ' active' : '';
        let html = `
            <div class="nx-tree-row${active}" data-folder-id="${f.id}" style="padding-left:${8 + depth * 16}px">
                ${hasKids
                    ? `<button class="nx-tree-expand" data-toggle="${f.id}"><i class="fa-solid fa-chevron-${isExpanded ? 'down' : 'right'}"></i></button>`
                    : `<span class="nx-tree-expand-spacer"></span>`}
                <span class="nx-folder-dot" style="background:${f.color || 'var(--accent)'}" data-color="${f.id}"></span>
                <span class="nx-tree-name">${esc(f.name)}</span>
                <span class="nx-tree-count">${count}</span>
                <span class="nx-tree-actions">
                    <button class="nx-icon-btn" data-add-sub="${f.id}" title="Nueva subcarpeta"><i class="fa-solid fa-folder-plus"></i></button>
                    <button class="nx-icon-btn" data-rename="${f.id}" title="Renombrar"><i class="fa-solid fa-pen"></i></button>
                    <button class="nx-icon-btn danger" data-delete="${f.id}" title="Borrar"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>`;
        if (hasKids && (isExpanded || q)) {
            for (const kid of kids) html += rowHtml(kid, depth + 1);
        }
        return html;
    }

    let html = `
        <div class="nx-tree-row nx-tree-pseudo${activeFolderId === null && activeTab === 'folders' ? ' active' : ''}" data-folder-id="">
            <span class="nx-tree-expand-spacer"></span>
            <i class="fa-solid fa-users nx-folder-dot-icon"></i>
            <span class="nx-tree-name">Todos los personajes</span>
        </div>
        <div class="nx-tree-divider"></div>
    `;

    if (matches) {
        if (!matches.length) {
            html += `<div class="nx-tree-empty">Sin carpetas que coincidan con "${esc(searchQuery)}"</div>`;
        } else {
            for (const f of matches) html += rowHtml(f, 0);
        }
    } else {
        const roots = childrenOf(null);
        if (!roots.length) {
            html += `<div class="nx-tree-empty">Aún no tienes carpetas.<br>Usa "Nueva carpeta" para crear la primera.</div>`;
        } else {
            for (const f of roots) html += rowHtml(f, 0);
        }
    }
    return html;
}

function renderTagList() {
    const all = getTags().slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const q = searchQuery;
    const filtered = q ? all.filter(t => (t.name || '').toLowerCase().includes(q)) : all;

    let html = `
        <div class="nx-tree-row nx-tree-pseudo${activeTagId === null ? ' active' : ''}" data-tag-id="">
            <span class="nx-tree-expand-spacer"></span>
            <i class="fa-solid fa-tags nx-folder-dot-icon"></i>
            <span class="nx-tree-name">Todos los tags</span>
        </div>
        <div class="nx-tree-divider"></div>
    `;

    if (!filtered.length) {
        html += `<div class="nx-tree-empty">${q ? `Sin tags que coincidan con "${esc(searchQuery)}"` : 'Aún no hay tags de SillyTavern.<br>Usa "Nuevo tag" para crear el primero.'}</div>`;
        return html;
    }

    for (const t of filtered) {
        const active = activeTagId === t.id ? ' active' : '';
        const count = tagCharCount(t.id);
        const isText = !t.color && !t.color2;
        html += `
            <div class="nx-tree-row${active}" data-tag-id="${t.id}">
                <span class="nx-tree-expand-spacer"></span>
                <span class="nx-tag-swatch${isText ? ' nx-tag-swatch-text' : ''}" style="${isText ? '' : `background:${t.color || '#888'};border-color:${t.color2 || t.color || '#888'}`}" data-tag-color="${t.id}">${isText ? esc((t.name || '?').slice(0, 1).toUpperCase()) : ''}</span>
                <span class="nx-tree-name">${esc(t.name)}</span>
                <span class="nx-tree-count">${count}</span>
                <span class="nx-tree-actions">
                    <button class="nx-icon-btn" data-tag-rename="${t.id}" title="Renombrar"><i class="fa-solid fa-pen"></i></button>
                    <button class="nx-icon-btn" data-tag-merge="${t.id}" title="Fusionar con otro tag"><i class="fa-solid fa-code-merge"></i></button>
                    <button class="nx-icon-btn danger" data-tag-delete="${t.id}" title="Borrar"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>`;
    }
    return html;
}

function wireTreeEvents(tree) {
    tree.querySelectorAll('[data-toggle]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.toggle;
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderTree();
        });
    });

    if (activeTab === 'folders') {
        tree.querySelectorAll('[data-folder-id]').forEach(row => {
            row.addEventListener('click', () => {
                activeFolderId = row.dataset.folderId || null;
                render();
            });
        });
        tree.querySelectorAll('[data-color]').forEach(dot => {
            dot.addEventListener('click', (e) => { e.stopPropagation(); pickFolderColor(dot.dataset.color); });
        });
        tree.querySelectorAll('[data-add-sub]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); createFolderFlow(btn.dataset.addSub); });
        });
        tree.querySelectorAll('[data-rename]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); renameFolderFlow(btn.dataset.rename); });
        });
        tree.querySelectorAll('[data-delete]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); deleteFolderFlow(btn.dataset.delete); });
        });
    } else {
        tree.querySelectorAll('[data-tag-id]').forEach(row => {
            row.addEventListener('click', () => {
                activeTagId = row.dataset.tagId || null;
                render();
            });
        });
        tree.querySelectorAll('[data-tag-color]').forEach(dot => {
            dot.addEventListener('click', (e) => { e.stopPropagation(); pickTagColor(dot.dataset.tagColor); });
        });
        tree.querySelectorAll('[data-tag-rename]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); renameTagFlow(btn.dataset.tagRename); });
        });
        tree.querySelectorAll('[data-tag-merge]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); mergeTagFlow(btn.dataset.tagMerge); });
        });
        tree.querySelectorAll('[data-tag-delete]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); deleteTagFlow(btn.dataset.tagDelete); });
        });
    }
}

// ========================================
// MAIN PANEL (right column) — character grid for the selected folder/tag
// ========================================
function renderMain() {
    const main = document.getElementById('nxMain');
    if (!main) return;

    let chars = [];
    let title = '';
    let allowAssign = true;

    if (activeTab === 'folders') {
        if (activeFolderId) {
            const f = findFolder(activeFolderId);
            if (!f) { activeFolderId = null; }
        }
        if (activeFolderId) {
            const f = findFolder(activeFolderId);
            title = f.name;
            chars = (f.characters || []).map(a => CoreAPI.getCharacterByAvatar(a)).filter(Boolean);
        } else {
            title = 'Todos los personajes';
            chars = CoreAPI.getAllCharacters() || [];
            allowAssign = false;
        }
    } else {
        if (activeTagId) {
            const t = getTags().find(x => x.id === activeTagId);
            if (!t) { activeTagId = null; }
        }
        if (activeTagId) {
            const t = getTags().find(x => x.id === activeTagId);
            title = t.name;
            chars = charsForTag(activeTagId);
        } else {
            title = 'Todos los tags';
            main.innerHTML = `<div class="nx-main-empty"><i class="fa-solid fa-tags" style="font-size:2em;opacity:.4"></i><br><br>Selecciona un tag de la izquierda para ver sus personajes,<br>o gestiona colores, nombres y fusiones desde los iconos de la lista.</div>`;
            return;
        }
    }

    const headerBtn = allowAssign
        ? `<button class="cl-btn cl-btn-secondary" id="nxAssignBtn"><i class="fa-solid fa-user-plus"></i> Añadir personajes</button>`
        : '';

    if (!chars.length) {
        main.innerHTML = `
            <div class="nx-main-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0">${esc(title)}</h3>
                ${headerBtn}
            </div>
            <div class="nx-main-empty">No hay personajes aquí todavía.</div>
        `;
    } else {
        main.innerHTML = `
            <div class="nx-main-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0">${esc(title)} <span class="nx-tree-count">(${chars.length})</span></h3>
                ${headerBtn}
            </div>
            <div class="nx-char-grid">
                ${chars.map(c => `
                    <div class="nx-char-card" data-avatar="${esc(c.avatar)}" title="${esc(CoreAPI.getCharacterName(c))}">
                        <img src="${CoreAPI.getCharacterAvatarUrl(c.avatar)}" loading="lazy" alt="">
                        <span class="nx-char-name">${esc(CoreAPI.getCharacterName(c))}</span>
                        ${allowAssign ? `<button class="nx-icon-btn danger nx-char-remove" data-remove="${esc(c.avatar)}" title="Quitar de la carpeta"><i class="fa-solid fa-xmark"></i></button>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }

    main.querySelectorAll('.nx-char-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-remove]')) return;
            const char = CoreAPI.getCharacterByAvatar(card.dataset.avatar);
            if (char) CoreAPI.openCharacterModal?.(char);
        });
    });
    main.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeCharFromFolder(activeFolderId, btn.dataset.remove);
        });
    });
    document.getElementById('nxAssignBtn')?.addEventListener('click', () => {
        if (activeTab === 'folders') openCharacterPicker({
            excluded: new Set(findFolder(activeFolderId)?.characters || []),
            onPick: (avatar) => addCharToFolder(activeFolderId, avatar),
        });
        else openCharacterPicker({
            excluded: new Set(charsForTag(activeTagId).map(c => c.avatar)),
            onPick: (avatar) => addCharToTag(activeTagId, avatar),
        });
    });
}

// ========================================
// FOLDER ACTIONS
// ========================================
async function createFolderFlow(parentId) {
    const name = await promptText('Nueva carpeta', 'Nombre de la carpeta', '');
    if (!name) return;
    const list = getFolders();
    list.push({ id: genId(), name, parentId: parentId || null, color: randomColor(), characters: [] });
    saveFolders(list);
    if (parentId) expanded.add(parentId);
    render();
}

async function renameFolderFlow(id) {
    const f = findFolder(id);
    if (!f) return;
    const name = await promptText('Renombrar carpeta', 'Nombre de la carpeta', f.name);
    if (!name) return;
    const list = getFolders();
    const target = list.find(x => x.id === id);
    target.name = name;
    saveFolders(list);
    render();
}

async function deleteFolderFlow(id) {
    const f = findFolder(id);
    if (!f) return;
    const kids = descendantIds(id).length - 1;
    const msg = kids > 0
        ? `¿Borrar la carpeta "${f.name}" y sus ${kids} subcarpeta(s)? Los personajes no se borran, solo dejan de estar en la carpeta.`
        : `¿Borrar la carpeta "${f.name}"? Los personajes no se borran, solo dejan de estar en la carpeta.`;
    const ok = await CoreAPI.showConfirm({ title: 'Borrar carpeta', message: msg, confirmLabel: 'Borrar', danger: true });
    if (!ok) return;
    const toRemove = new Set(descendantIds(id));
    const list = getFolders().filter(x => !toRemove.has(x.id));
    saveFolders(list);
    if (toRemove.has(activeFolderId)) activeFolderId = null;
    render();
}

function pickFolderColor(id) {
    const f = findFolder(id);
    if (!f) return;
    openColorPicker(f.color || '#888888', (color) => {
        const list = getFolders();
        list.find(x => x.id === id).color = color;
        saveFolders(list);
        render();
    });
}

function addCharToFolder(folderId, avatar) {
    if (!folderId) return;
    const list = getFolders();
    const f = list.find(x => x.id === folderId);
    if (!f) return;
    // A character lives in exactly one folder at a time, same as CTM's original model —
    // remove it from any other folder before assigning it here.
    for (const other of list) {
        if (other.id !== folderId && Array.isArray(other.characters) && other.characters.includes(avatar)) {
            other.characters = other.characters.filter(a => a !== avatar);
        }
    }
    if (!f.characters) f.characters = [];
    if (!f.characters.includes(avatar)) f.characters.push(avatar);
    saveFolders(list);
    renderMain();
    renderTree();
}

// Returns { id, name, color } for the folder a character currently belongs to, or null.
// Exposed on window.OrganizeModule so card rendering / the character modal can show it.
function getFolderForChar(avatar) {
    if (!avatar) return null;
    const f = getFolders().find(x => Array.isArray(x.characters) && x.characters.includes(avatar));
    return f ? { id: f.id, name: f.name, color: f.color } : null;
}

function folderPath(id) {
    const names = [];
    let cur = findFolder(id);
    while (cur) {
        names.unshift(cur.name);
        cur = cur.parentId ? findFolder(cur.parentId) : null;
    }
    return names.join(' / ');
}

// Populates the "Carpeta" sidebar section in the character detail modal.
function renderModalFolderSection(avatar) {
    const container = document.getElementById('modalFolder');
    if (!container) return;
    const f = getFolders().find(x => Array.isArray(x.characters) && x.characters.includes(avatar));
    if (!f) {
        container.innerHTML = `
            <span class="nx-modal-folder-empty">Sin carpeta</span>
            <button class="nx-modal-folder-change" id="nxModalFolderChange">asignar</button>
        `;
    } else {
        container.innerHTML = `
            <span class="nx-modal-folder-chip"><i class="fa-solid fa-folder" style="color:${esc(f.color || '#8b2ae6')}"></i> ${esc(folderPath(f.id))}</span>
            <button class="nx-modal-folder-change" id="nxModalFolderChange">cambiar</button>
        `;
    }
    document.getElementById('nxModalFolderChange')?.addEventListener('click', async () => {
        const all = getFolders();
        if (!all.length) {
            CoreAPI.showToast('Crea antes una carpeta en la pestaña Carpetas', 'info');
            return;
        }
        const options = [{ value: '', label: '— Sin carpeta —' }, ...all.map(x => ({ value: x.id, label: folderPath(x.id) }))];
        const chosen = await promptSelect('Mover a carpeta', options);
        if (chosen === null) return;
        if (chosen === '') {
            const list = getFolders();
            for (const fl of list) fl.characters = (fl.characters || []).filter(a => a !== avatar);
            saveFolders(list);
        } else {
            addCharToFolder(chosen, avatar);
        }
        renderModalFolderSection(avatar);
        // Refresh the grid badge for this character too, if visible.
        document.querySelectorAll(`.char-card[data-avatar="${CSS.escape(avatar)}"] .nx-folder-indicator`).forEach(el => el.remove());
        const updated = getFolderForChar(avatar);
        if (updated) {
            document.querySelectorAll(`.char-card[data-avatar="${CSS.escape(avatar)}"]`).forEach(card => {
                const div = document.createElement('div');
                div.className = 'nx-folder-indicator';
                div.title = updated.name;
                div.style.color = updated.color || '#8b2ae6';
                div.innerHTML = '<i class="fa-solid fa-folder"></i>';
                card.appendChild(div);
            });
        }
    });
}

function removeCharFromFolder(folderId, avatar) {
    if (!folderId) return;
    const list = getFolders();
    const f = list.find(x => x.id === folderId);
    if (!f) return;
    f.characters = (f.characters || []).filter(a => a !== avatar);
    saveFolders(list);
    renderMain();
    renderTree();
}

// ========================================
// TAG ACTIONS (native ST tags — live refs + saveSettingsDebounced, same pattern
// the rest of the extension already uses)
// ========================================
async function createTagFlow() {
    const name = await promptText('Nuevo tag', 'Nombre del tag', '');
    if (!name) return;
    const c = ctx();
    if (!c || !Array.isArray(c.tags)) return;
    const id = 'nx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    c.tags.push({ id, name, color: randomColor(), color2: '' });
    persistST();
    render();
}

async function renameTagFlow(id) {
    const t = getTags().find(x => x.id === id);
    if (!t) return;
    const name = await promptText('Renombrar tag', 'Nombre del tag', t.name);
    if (!name) return;
    t.name = name;
    persistST();
    render();
}

async function deleteTagFlow(id) {
    const t = getTags().find(x => x.id === id);
    if (!t) return;
    const count = tagCharCount(id);
    const ok = await CoreAPI.showConfirm({
        title: 'Borrar tag',
        message: count > 0
            ? `¿Borrar el tag "${t.name}"? Se quitará de ${count} personaje(s).`
            : `¿Borrar el tag "${t.name}"?`,
        confirmLabel: 'Borrar',
        danger: true,
    });
    if (!ok) return;
    const c = ctx();
    if (!c) return;
    c.tags = c.tags.filter(x => x.id !== id);
    const map = c.tagMap || {};
    for (const avatar in map) {
        if (Array.isArray(map[avatar])) map[avatar] = map[avatar].filter(x => x !== id);
    }
    persistST();
    if (activeTagId === id) activeTagId = null;
    render();
}

function pickTagColor(id) {
    const t = getTags().find(x => x.id === id);
    if (!t) return;
    openColorPicker(t.color || '#888888', (color) => {
        t.color = color;
        persistST();
        render();
    }, t.color2 || '', (color2) => {
        t.color2 = color2;
        persistST();
        render();
    });
}

async function mergeTagFlow(id) {
    const t = getTags().find(x => x.id === id);
    if (!t) return;
    const others = getTags().filter(x => x.id !== id);
    if (!others.length) {
        CoreAPI.showToast('No hay otro tag con el que fusionar', 'info');
        return;
    }
    const targetId = await promptSelect(`Fusionar "${t.name}" con...`, others.map(o => ({ value: o.id, label: o.name })));
    if (!targetId) return;
    const target = getTags().find(x => x.id === targetId);
    const c = ctx();
    const map = c.tagMap || {};
    for (const avatar in map) {
        if (!Array.isArray(map[avatar])) continue;
        if (map[avatar].includes(id) && !map[avatar].includes(targetId)) {
            map[avatar].push(targetId);
        }
        map[avatar] = map[avatar].filter(x => x !== id);
    }
    c.tags = c.tags.filter(x => x.id !== id);
    persistST();
    CoreAPI.showToast(`"${t.name}" fusionado en "${target.name}"`, 'success');
    if (activeTagId === id) activeTagId = targetId;
    render();
}

function addCharToTag(tagId, avatar) {
    if (!tagId) return;
    const c = ctx();
    if (!c.tagMap) c.tagMap = {};
    if (!c.tagMap[avatar]) c.tagMap[avatar] = [];
    if (!c.tagMap[avatar].includes(tagId)) c.tagMap[avatar].push(tagId);
    persistST();
    renderMain();
    renderTree();
}

// ========================================
// CTM IMPORT — reads CTM's own extensionSettings key (still present even after
// CTM itself is uninstalled) and converts its folder tree into ours.
// CTM format (stcm_folders_v2): array of
//   { id, name, icon, color, parentId, children: [childId,...], characters: [avatar,...], private }
// with a special root node id === 'root'. We drop `private`/PIN and `icon` per
// the user's request — everything else maps 1:1.
// ========================================
const CTM_KEY = 'stcm_folders_v2';

function getCTMFolders() {
    const c = ctx();
    const data = c?.extensionSettings?.[CTM_KEY];
    return Array.isArray(data) ? data : null;
}

async function importFromCTMFlow() {
    const ctmFolders = getCTMFolders();
    if (!ctmFolders || !ctmFolders.length) {
        CoreAPI.showToast('No se encontraron carpetas de CTM (clave "stcm_folders_v2" vacía o ausente)', 'info');
        return;
    }
    const importableCount = ctmFolders.filter(f => f.id !== 'root').length;
    if (!importableCount) {
        CoreAPI.showToast('CTM solo tiene la carpeta raíz, nada que importar', 'info');
        return;
    }
    const ok = await CoreAPI.showConfirm({
        title: 'Importar carpetas de CTM',
        message: `Se importarán ${importableCount} carpeta(s) de Character Tag Manager como nuevas carpetas aquí (se añaden a las que ya tengas, no se borra nada). El PIN/privado no se importa.`,
        confirmLabel: 'Importar',
    });
    if (!ok) return;

    // Map CTM ids -> our new ids, so imported folders never collide with existing ones.
    const idMap = new Map();
    for (const f of ctmFolders) {
        if (f.id === 'root') { idMap.set(f.id, null); continue; }
        idMap.set(f.id, genId());
    }

    const imported = ctmFolders
        .filter(f => f.id !== 'root')
        .map(f => ({
            id: idMap.get(f.id),
            name: f.name || 'Sin nombre',
            parentId: idMap.has(f.parentId) ? idMap.get(f.parentId) : null,
            color: f.color || randomColor(),
            characters: Array.isArray(f.characters) ? [...f.characters] : [],
        }));

    const list = getFolders().concat(imported);
    saveFolders(list);
    CoreAPI.showToast(`${imported.length} carpeta(s) importada(s) de CTM`, 'success');
    render();
}

// ========================================
// SMALL SHARED UI: prompt modal, select modal, color picker, character picker
// ========================================
function randomColor() {
    const palette = ['#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#64b5f6',
        '#4fc3f7', '#4dd0e1', '#4db6ac', '#81c784', '#aed581', '#ffd54f', '#ffb74d', '#ff8a65'];
    return palette[Math.floor(Math.random() * palette.length)];
}

function buildOverlay(id, innerClass, bodyHtml) {
    let overlay = document.getElementById(id);
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'modal-overlay hidden';
    overlay.innerHTML = `<div class="${innerClass}">${bodyHtml}</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay(overlay);
    });
    return overlay;
}
function openOverlay(overlay) {
    overlay.classList.remove('hidden');
    const escHandler = (e) => {
        if (e.key === 'Escape') { closeOverlay(overlay); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);
    overlay._escHandler = escHandler;
}
function closeOverlay(overlay) {
    overlay.classList.add('hidden');
    if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
}

function promptText(title, placeholder, initial) {
    return new Promise((resolve) => {
        const overlay = buildOverlay('nxPromptModal', 'nx-prompt-modal', `
            <div class="modal-header"><h2>${esc(title)}</h2><button class="close-btn" id="nxPromptClose">&times;</button></div>
            <div class="nx-prompt-body"><input type="text" class="cl-input" id="nxPromptInput" placeholder="${esc(placeholder)}"></div>
            <div class="nx-prompt-actions">
                <button class="cl-btn cl-btn-secondary" id="nxPromptCancel">Cancelar</button>
                <button class="cl-btn cl-btn-primary" id="nxPromptOk">Guardar</button>
            </div>
        `);
        const input = overlay.querySelector('#nxPromptInput');
        input.value = initial || '';
        const finish = (val) => { closeOverlay(overlay); resolve(val); };
        overlay.querySelector('#nxPromptClose').addEventListener('click', () => finish(null));
        overlay.querySelector('#nxPromptCancel').addEventListener('click', () => finish(null));
        overlay.querySelector('#nxPromptOk').addEventListener('click', () => finish(input.value.trim() || null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') finish(input.value.trim() || null);
        });
        openOverlay(overlay);
        setTimeout(() => input.focus(), 0);
    });
}

function promptSelect(title, options, okLabel) {
    return new Promise((resolve) => {
        const optsHtml = options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
        const overlay = buildOverlay('nxSelectModal', 'nx-prompt-modal', `
            <div class="modal-header"><h2>${esc(title)}</h2><button class="close-btn" id="nxSelectClose">&times;</button></div>
            <div class="nx-prompt-body"><select class="cl-input" id="nxSelectInput">${optsHtml}</select></div>
            <div class="nx-prompt-actions">
                <button class="cl-btn cl-btn-secondary" id="nxSelectCancel">Cancelar</button>
                <button class="cl-btn cl-btn-primary" id="nxSelectOk">${esc(okLabel || 'Fusionar')}</button>
            </div>
        `);
        const select = overlay.querySelector('#nxSelectInput');
        let resolved = false;
        const finish = (val) => { if (resolved) return; resolved = true; closeOverlay(overlay); resolve(val); };
        overlay.querySelector('#nxSelectClose').addEventListener('click', () => finish(null));
        overlay.querySelector('#nxSelectCancel').addEventListener('click', () => finish(null));
        overlay.querySelector('#nxSelectOk').addEventListener('click', () => finish(select.value));
        openOverlay(overlay);
    });
}

function openColorPicker(initial, onChange, initial2, onChange2) {
    const overlay = buildOverlay('nxColorModal', 'nx-prompt-modal', `
        <div class="modal-header"><h2>Color</h2><button class="close-btn" id="nxColorClose">&times;</button></div>
        <div class="nx-prompt-body" style="display:flex;flex-direction:column;gap:12px;">
            <label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                <span>${onChange2 ? 'Fondo' : 'Color'}</span>
                <input type="color" id="nxColorInput1" value="${initial || '#888888'}">
            </label>
            ${onChange2 ? `<label style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
                <span>Texto/borde</span>
                <input type="color" id="nxColorInput2" value="${initial2 || '#ffffff'}">
            </label>` : ''}
        </div>
        <div class="nx-prompt-actions">
            <button class="cl-btn cl-btn-primary" id="nxColorDone">Listo</button>
        </div>
    `);
    overlay.querySelector('#nxColorInput1').addEventListener('input', (e) => onChange(e.target.value));
    overlay.querySelector('#nxColorInput2')?.addEventListener('input', (e) => onChange2(e.target.value));
    overlay.querySelector('#nxColorClose').addEventListener('click', () => closeOverlay(overlay));
    overlay.querySelector('#nxColorDone').addEventListener('click', () => closeOverlay(overlay));
    openOverlay(overlay);
}

function openCharacterPicker({ excluded, onPick }) {
    const overlay = buildOverlay('nxPickerModal', 'nx-picker-modal', `
        <div class="modal-header"><h2>Añadir personajes</h2><button class="close-btn" id="nxPickerClose">&times;</button></div>
        <div class="nx-picker-search">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input type="search" id="nxPickerSearch" placeholder="Buscar personaje...">
        </div>
        <div class="nx-picker-list" id="nxPickerList"></div>
    `);
    const list = overlay.querySelector('#nxPickerList');
    const searchInput = overlay.querySelector('#nxPickerSearch');

    function renderList() {
        const q = searchInput.value.trim().toLowerCase();
        const all = (CoreAPI.getAllCharacters() || []).filter(c => !excluded.has(c.avatar));
        const filtered = q ? all.filter(c => CoreAPI.getCharacterName(c).toLowerCase().includes(q)) : all;
        if (!filtered.length) {
            list.innerHTML = `<div class="nx-tree-empty">Sin resultados.</div>`;
            return;
        }
        list.innerHTML = filtered.map(c => `
            <div class="nx-picker-row" data-avatar="${esc(c.avatar)}">
                <img src="${CoreAPI.getCharacterAvatarUrl(c.avatar)}" loading="lazy" alt="">
                <span>${esc(CoreAPI.getCharacterName(c))}</span>
            </div>
        `).join('');
        list.querySelectorAll('.nx-picker-row').forEach(row => {
            row.addEventListener('click', () => {
                onPick(row.dataset.avatar);
                excluded.add(row.dataset.avatar);
                renderList();
            });
        });
    }
    searchInput.addEventListener('input', renderList);
    overlay.querySelector('#nxPickerClose').addEventListener('click', () => closeOverlay(overlay));
    renderList();
    openOverlay(overlay);
    setTimeout(() => searchInput.focus(), 0);
}

// ========================================
// NOTE on native #rm_print_characters_block grouping
// ========================================
// This used to live here, but organize.js only runs while the "Carpetas" tab
// (library.html, a separate popup/tab) is open — closing it stops the script,
// and ST's next re-render of the character list wipes out anything it
// injected. That logic now lives in the extension's main index.js instead,
// which runs continuously in the real ST page for as long as ST is open
// (same as CTM's own index.js). It reads the same `nxFolders` data this
// module writes via saveFolders() below — nothing further needed here.

export default {
    activate,
    getFolders,
    getFolderForChar,
    renderModalFolderSection,
};
