/**
 * Instructions Widget — a self-contained help modal for one-page projects.
 *
 * Drop this file + the <link> and <script> tags into any HTML page, then
 * serve an `intro.md` alongside it. The widget handles everything else.
 *
 * Features:
 * - ? icon button in the top‑right corner
 * - Modal that renders Markdown (via marked.js CDN)
 * - Auto‑opens on first visit (tracked via localStorage)
 * - Storage key is a hash of the Markdown content, so:
 *     • works across projects on the same domain without conflicts
 *     • automatically re‑opens when the Markdown file changes
 * - Fully isolated — no dependency on p5.js or other frameworks
 */

;(function () {
  'use strict'

  const MARKDOWN_URL = 'intro.md'

  // ── Tiny hash function (DJB2) ───────────────────────────────────

  function hashStr (str) {
    let h = 5381
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0
    }
    return 'instr_' + Math.abs(h).toString(36)
  }

  // ── Create DOM structure ──────────────────────────────────────────

  const btn = document.createElement('button')
  btn.id = 'instructions-btn'
  btn.innerHTML = '?'
  btn.setAttribute('aria-label', 'Open instructions')

  const overlay = document.createElement('div')
  overlay.id = 'instructions-overlay'

  const modal = document.createElement('div')
  modal.id = 'instructions-modal'

  const closeBtn = document.createElement('button')
  closeBtn.id = 'instructions-close'
  closeBtn.innerHTML = '&times;'
  closeBtn.setAttribute('aria-label', 'Close instructions')

  const content = document.createElement('div')
  content.id = 'instructions-content'

  modal.appendChild(closeBtn)
  modal.appendChild(content)
  overlay.appendChild(modal)
  document.body.appendChild(btn)
  document.body.appendChild(overlay)

  // ── Load & render Markdown ───────────────────────────────────────

  function renderMarkdown (md) {
    if (typeof window.marked !== 'undefined') {
      content.innerHTML = window.marked.parse(md)
    } else {
      content.innerHTML = simpleMarkdown(md)
    }
  }

  function loadMarkdown () {
    content.innerHTML = '<p style="color:#999;">Loading…</p>'
    fetch(MARKDOWN_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load ' + MARKDOWN_URL)
        return res.text()
      })
      .then(renderMarkdown)
      .catch(function (err) {
        content.innerHTML =
          '<p style="color:red;">Could not load instructions.</p>'
        console.error(err)
      })
  }

  // ── Simple Markdown fallback (headings, paragraphs, links, images) ─

  function simpleMarkdown (text) {
    return text
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;">')
      .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .split(/\n\n+/)
      .map(function (block) {
        var trimmed = block.trim()
        if (!trimmed) return ''
        if (/^<h[1-3]/.test(trimmed)) return trimmed
        return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>'
      })
      .join('\n')
  }

  // ── Open / close ─────────────────────────────────────────────────

  function openModal () {
    overlay.classList.add('visible')
    document.body.classList.add('instructions-open')
    loadMarkdown()
  }

  function closeModal () {
    overlay.classList.remove('visible')
    document.body.classList.remove('instructions-open')
  }

  btn.addEventListener('click', openModal)
  closeBtn.addEventListener('click', closeModal)

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal()
  })

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay.classList.contains('visible')) {
      closeModal()
    }
  })

  // ── First‑visit auto‑open ────────────────────────────────────────
  //
  // Fetch the Markdown file, hash its content, and check localStorage.
  // If the hash key is missing (first visit OR content changed), show
  // the modal and persist the new key.

  fetch(MARKDOWN_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('Failed to load ' + MARKDOWN_URL)
      return res.text()
    })
    .then(function (md) {
      var key = hashStr(md)
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, 'true')
        renderMarkdown(md)
        setTimeout(openModal, 300)
      }
    })
    .catch(function (err) {
      console.error('Instructions widget: could not check first-visit.', err)
    })
})()