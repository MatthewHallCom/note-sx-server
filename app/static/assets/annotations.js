(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var _toolbar = null;
  var _sidebarEl = null;
  var _activeCardId = null; // Currently expanded card
  var _annotationsData = {}; // annotation.id -> annotation object (with replies)
  var _nicknamePromise = null;
  var _renderedIds = {}; // Track rendered annotation IDs to prevent duplicates

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatTime(epoch) {
    if (!epoch) return '';
    var d = new Date(epoch * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function noteContainer() {
    return document.querySelector('.markdown-preview-sizer');
  }

  // ---------------------------------------------------------------------------
  // Nickname management
  // ---------------------------------------------------------------------------
  function getAuthor() {
    return localStorage.getItem('annotation-author');
  }

  function promptForNickname() {
    // Reuse an in-flight prompt so we don't stack modals
    if (_nicknamePromise) return _nicknamePromise;

    _nicknamePromise = new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'annotation-nickname-overlay';

      var modal = document.createElement('div');
      modal.className = 'annotation-nickname-modal';
      modal.innerHTML =
        '<h3 class="annotation-nickname-title">Enter your display name</h3>' +
        '<input class="annotation-nickname-input" type="text" placeholder="Your name" maxlength="60" />' +
        '<button class="annotation-nickname-save">Save</button>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      var input = modal.querySelector('.annotation-nickname-input');
      var btn = modal.querySelector('.annotation-nickname-save');

      function finish() {
        var val = input.value.trim();
        if (!val) return;                       // Require something
        localStorage.setItem('annotation-author', val);
        overlay.remove();
        _nicknamePromise = null;
        resolve(val);
      }

      btn.addEventListener('click', finish);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') finish();
        if (e.key === 'Escape') {
          overlay.remove();
          _nicknamePromise = null;
          resolve(null);
        }
      });

      // Close on overlay click (outside modal)
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
          overlay.remove();
          _nicknamePromise = null;
          resolve(null);
        }
      });

      setTimeout(function () { input.focus(); }, 50);
    });

    return _nicknamePromise;
  }

  // ---------------------------------------------------------------------------
  // Text anchoring — serialization
  // ---------------------------------------------------------------------------
  function serializeSelection() {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;

    var range = sel.getRangeAt(0);
    var quote = sel.toString();
    if (!quote || !quote.trim()) return null;

    var container = noteContainer();
    if (!container) return null;

    var fullText = container.textContent;
    var quoteStart = fullText.indexOf(quote);
    if (quoteStart === -1) return null;

    var prefix = fullText.slice(Math.max(0, quoteStart - 30), quoteStart);
    var suffix = fullText.slice(quoteStart + quote.length, quoteStart + quote.length + 30);

    return {
      quote: quote,
      prefix: prefix,
      suffix: suffix,
      quote_offset: quoteStart
    };
  }

  // ---------------------------------------------------------------------------
  // Text anchoring — resolution (finding text in DOM)
  // ---------------------------------------------------------------------------
  function textOffsetToRange(container, startOffset, endOffset) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    var currentOffset = 0;
    var startNode = null;
    var startNodeOffset = 0;
    var endNode = null;
    var endNodeOffset = 0;

    while (walker.nextNode()) {
      var node = walker.currentNode;
      var nodeLen = node.textContent.length;

      if (!startNode && currentOffset + nodeLen > startOffset) {
        startNode = node;
        startNodeOffset = startOffset - currentOffset;
      }
      if (currentOffset + nodeLen >= endOffset) {
        endNode = node;
        endNodeOffset = endOffset - currentOffset;
        break;
      }
      currentOffset += nodeLen;
    }

    if (!startNode || !endNode) return null;

    var range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  }

  function resolveAnchor(annotation) {
    var container = noteContainer();
    if (!container) return null;

    var fullText = container.textContent;

    // Try prefix+quote+suffix context match first
    var searchStr = (annotation.prefix || '') + annotation.quote + (annotation.suffix || '');
    var contextIdx = fullText.indexOf(searchStr);

    var quoteStart;
    if (contextIdx !== -1) {
      quoteStart = contextIdx + (annotation.prefix || '').length;
    } else {
      // Fallback: just the quote, using offset hint
      var hintStart = Math.max(0, (annotation.quote_offset || 0) - 50);
      quoteStart = fullText.indexOf(annotation.quote, hintStart);
      if (quoteStart === -1) {
        quoteStart = fullText.indexOf(annotation.quote);
      }
    }

    if (quoteStart === -1) return null;

    return textOffsetToRange(container, quoteStart, quoteStart + annotation.quote.length);
  }

  // ---------------------------------------------------------------------------
  // Rendering — inline wrapping
  // ---------------------------------------------------------------------------
  function wrapRange(range, wrapper) {
    try {
      range.surroundContents(wrapper);
    } catch (_e) {
      // surroundContents fails when the range crosses element boundaries.
      // Fallback: extract, wrap, and re-insert.
      var fragment = range.extractContents();
      wrapper.appendChild(fragment);
      range.insertNode(wrapper);
    }
  }

  // ---------------------------------------------------------------------------
  // Sidebar management
  // ---------------------------------------------------------------------------
  // Find the scrolling ancestor of the note content
  function findScrollParent(el) {
    while (el && el !== document.body) {
      var style = getComputedStyle(el);
      if ((style.overflow === 'auto' || style.overflow === 'scroll' ||
           style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return document.documentElement;
  }

  function ensureSidebar() {
    if (_sidebarEl) return _sidebarEl;

    // Find the scrolling container and place cards inside it,
    // so they scroll naturally with the document content.
    var container = noteContainer();
    var scrollParent = container ? findScrollParent(container) : document.body;

    // Make sure the scroll parent is a positioning context
    var spStyle = getComputedStyle(scrollParent);
    if (spStyle.position === 'static') {
      scrollParent.style.position = 'relative';
    }

    var layer = document.createElement('div');
    layer.className = 'annotation-cards-layer';
    scrollParent.appendChild(layer);

    _sidebarEl = layer;

    window.addEventListener('resize', function () { positionCards(); });

    return layer;
  }

  // Get an element's offset relative to a specific ancestor
  function getOffsetRelativeTo(el, ancestor) {
    var top = 0;
    var current = el;
    while (current && current !== ancestor) {
      top += current.offsetTop;
      current = current.offsetParent;
    }
    return top;
  }

  // Position cards to align vertically with their inline highlights
  function positionCards() {
    if (!_sidebarEl) return;
    var cards = _sidebarEl.querySelectorAll('.annotation-sidebar-card');
    if (!cards.length) return;

    var scrollParent = _sidebarEl.parentElement;
    if (!scrollParent) return;

    // Position the layer horizontally to the right of the note content
    var container = noteContainer();
    if (container) {
      var containerRect = container.getBoundingClientRect();
      var parentRect = scrollParent.getBoundingClientRect();
      _sidebarEl.style.left = (containerRect.right - parentRect.left + 16) + 'px';
    }

    // Collect desired top positions relative to the scroll parent
    var positions = [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var annotationId = card.dataset.annotationId;
      var inlineEl = document.querySelector('.annotation[data-annotation-id="' + annotationId + '"]');

      var desiredTop = (i * 80) + 100; // fallback
      if (inlineEl) {
        desiredTop = getOffsetRelativeTo(inlineEl, scrollParent);
      }
      positions.push({ card: card, desired: desiredTop, height: card.offsetHeight });
    }

    // Sort by desired position
    positions.sort(function (a, b) { return a.desired - b.desired; });

    // Resolve overlaps: push cards down if they would overlap
    var minGap = 6;
    var currentBottom = 0;
    for (var j = 0; j < positions.length; j++) {
      var pos = positions[j];
      var top = Math.max(pos.desired, currentBottom);
      pos.card.style.top = top + 'px';
      currentBottom = top + pos.height + minGap;
    }
  }

  // ---------------------------------------------------------------------------
  // Sidebar card rendering
  // ---------------------------------------------------------------------------
  function createReplyEl(reply) {
    var el = document.createElement('div');
    el.className = 'annotation-card-reply';
    el.dataset.replyId = reply.id;
    el.innerHTML =
      '<div class="annotation-card-reply-header">' +
        '<span class="annotation-card-reply-author">' + escapeHtml(reply.author_name) + '</span>' +
        '<span class="annotation-card-reply-time">' + formatTime(reply.created) + '</span>' +
      '</div>' +
      '<div class="annotation-card-reply-body">' + escapeHtml(reply.body) + '</div>';
    return el;
  }

  function createAnnotationCard(annotation) {
    var card = document.createElement('div');
    card.className = 'annotation-sidebar-card';
    card.dataset.annotationId = annotation.id;

    // Type indicator color
    var typeClass = 'card-type-' + annotation.type;
    card.classList.add(typeClass);

    // Collapsed view (always visible)
    var header = document.createElement('div');
    header.className = 'annotation-card-header';

    var authorEl = document.createElement('span');
    authorEl.className = 'annotation-card-author';
    authorEl.textContent = annotation.author_name;

    var timeEl = document.createElement('span');
    timeEl.className = 'annotation-card-time';
    timeEl.textContent = formatTime(annotation.created);

    header.appendChild(authorEl);
    header.appendChild(timeEl);
    card.appendChild(header);

    // Quoted text snippet
    var quoteEl = document.createElement('div');
    quoteEl.className = 'annotation-card-quote';
    var quoteText = annotation.quote;
    if (quoteText.length > 60) quoteText = quoteText.slice(0, 60) + '...';
    quoteEl.textContent = '\u201C' + quoteText + '\u201D';
    card.appendChild(quoteEl);

    // Body (comment text or suggestion)
    if (annotation.body) {
      var bodyEl = document.createElement('div');
      bodyEl.className = 'annotation-card-body';
      if (annotation.type === 'suggestion') {
        bodyEl.innerHTML = '<span class="annotation-card-suggestion-label">Suggested:</span> ' + escapeHtml(annotation.body);
      } else {
        bodyEl.textContent = annotation.body;
      }
      card.appendChild(bodyEl);
    } else if (annotation.type === 'deletion') {
      var delEl = document.createElement('div');
      delEl.className = 'annotation-card-body annotation-card-deletion-label';
      delEl.textContent = 'Marked for deletion';
      card.appendChild(delEl);
    }

    // Reply count indicator (collapsed)
    var replies = (annotation.replies || []);
    if (replies.length > 0) {
      var replyCount = document.createElement('div');
      replyCount.className = 'annotation-card-reply-count';
      replyCount.textContent = replies.length + (replies.length === 1 ? ' reply' : ' replies');
      card.appendChild(replyCount);
    }

    // Thread container (hidden until expanded)
    var thread = document.createElement('div');
    thread.className = 'annotation-card-thread';
    thread.style.display = 'none';

    // Render existing replies
    replies.forEach(function (reply) {
      thread.appendChild(createReplyEl(reply));
    });

    // Reply input
    var replyRow = document.createElement('div');
    replyRow.className = 'annotation-card-reply-input-row';
    var replyInput = document.createElement('input');
    replyInput.type = 'text';
    replyInput.className = 'annotation-card-reply-input';
    replyInput.placeholder = 'Reply...';
    var replyBtn = document.createElement('button');
    replyBtn.className = 'annotation-card-reply-btn';
    replyBtn.textContent = 'Reply';
    replyBtn.type = 'button';
    replyRow.appendChild(replyInput);
    replyRow.appendChild(replyBtn);
    thread.appendChild(replyRow);

    // Actions row (with remove button)
    var actions = document.createElement('div');
    actions.className = 'annotation-card-actions';
    var removeBtn = document.createElement('button');
    removeBtn.className = 'annotation-card-remove-btn';
    removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    removeBtn.title = 'Remove';
    actions.appendChild(removeBtn);
    thread.appendChild(actions);

    card.appendChild(thread);

    // --- Events ---

    // Click card to expand/collapse
    card.addEventListener('click', function (e) {
      // Don't toggle if clicking input, button, or remove
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.annotation-card-remove-btn')) return;
      toggleCard(annotation.id);
    });

    // Hover: highlight the inline annotation
    card.addEventListener('mouseenter', function () {
      highlightAnnotation(annotation.id, true);
    });
    card.addEventListener('mouseleave', function () {
      highlightAnnotation(annotation.id, false);
    });

    // Reply submit
    replyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      submitReply(annotation, replyInput, thread);
    });
    replyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.stopPropagation();
        submitReply(annotation, replyInput, thread);
      }
    });
    replyInput.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Remove button
    removeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var noteId = document.body.dataset.noteId;
      deleteAnnotation(noteId, annotation).then(function (ok) {
        if (ok) removeAnnotationFromDOM(annotation.id);
      });
    });

    return card;
  }

  // ---------------------------------------------------------------------------
  // Card expand/collapse and highlighting
  // ---------------------------------------------------------------------------
  function toggleCard(annotationId) {
    var card = _sidebarEl ? _sidebarEl.querySelector('[data-annotation-id="' + annotationId + '"]') : null;
    if (!card) return;

    var thread = card.querySelector('.annotation-card-thread');
    var isExpanded = card.classList.contains('expanded');

    // Collapse all other cards
    if (_sidebarEl) {
      var allCards = _sidebarEl.querySelectorAll('.annotation-sidebar-card.expanded');
      for (var i = 0; i < allCards.length; i++) {
        allCards[i].classList.remove('expanded');
        var t = allCards[i].querySelector('.annotation-card-thread');
        if (t) t.style.display = 'none';
      }
    }

    if (!isExpanded) {
      card.classList.add('expanded');
      if (thread) thread.style.display = 'block';
      _activeCardId = annotationId;

      // Scroll the highlighted text into view
      var inlineEl = document.querySelector('.annotation[data-annotation-id="' + annotationId + '"]');
      if (inlineEl) {
        inlineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      _activeCardId = null;
    }

    // Reposition after expand/collapse changes card heights
    setTimeout(positionCards, 0);
  }

  function highlightAnnotation(annotationId, highlight) {
    var elements = document.querySelectorAll('.annotation[data-annotation-id="' + annotationId + '"]');
    for (var i = 0; i < elements.length; i++) {
      if (highlight) {
        elements[i].classList.add('annotation-highlight-active');
      } else {
        elements[i].classList.remove('annotation-highlight-active');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reply submission
  // ---------------------------------------------------------------------------
  function submitReply(annotation, inputEl, threadEl) {
    var body = inputEl.value.trim();
    if (!body) return;

    var author = getAuthor();

    var doPost = function (authorName) {
      if (!authorName) return;
      var noteId = document.body.dataset.noteId;

      fetch('/v1/annotations/' + encodeURIComponent(noteId) + '/' + annotation.id + '/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body, author_name: authorName })
      })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data) return;
          // Insert reply before the input row
          var replyEl = createReplyEl(data.reply);
          var inputRow = threadEl.querySelector('.annotation-card-reply-input-row');
          threadEl.insertBefore(replyEl, inputRow);
          inputEl.value = '';

          // Update reply count
          updateReplyCount(annotation.id);
        })
        .catch(function (e) {
          console.warn('Failed to create reply:', e);
        });
    };

    if (author) {
      doPost(author);
    } else {
      promptForNickname().then(doPost);
    }
  }

  function updateReplyCount(annotationId) {
    if (!_sidebarEl) return;
    var card = _sidebarEl.querySelector('[data-annotation-id="' + annotationId + '"]');
    if (!card) return;
    var replies = card.querySelectorAll('.annotation-card-reply');
    var countEl = card.querySelector('.annotation-card-reply-count');
    var count = replies.length;
    if (count > 0) {
      if (!countEl) {
        countEl = document.createElement('div');
        countEl.className = 'annotation-card-reply-count';
        // Insert before thread
        var thread = card.querySelector('.annotation-card-thread');
        card.insertBefore(countEl, thread);
      }
      countEl.textContent = count + (count === 1 ? ' reply' : ' replies');
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering annotations (inline + sidebar card)
  // ---------------------------------------------------------------------------
  function renderAnnotation(annotation) {
    // Skip if already rendered (prevents double-render from create callback + SSE)
    if (_renderedIds[annotation.id]) return;
    _renderedIds[annotation.id] = true;

    // Store annotation data
    _annotationsData[annotation.id] = annotation;

    var range = resolveAnchor(annotation);
    if (!range) {
      addOrphanedAnnotation(annotation);
      return;
    }

    // Inline highlighting — click expands the sidebar card
    if (annotation.type === 'comment') {
      var wrapper = document.createElement('span');
      wrapper.className = 'annotation annotation-comment';
      wrapper.dataset.annotationId = annotation.id;
      wrapper.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCard(annotation.id);
      });
      wrapRange(range, wrapper);

    } else if (annotation.type === 'deletion') {
      var delWrapper = document.createElement('span');
      delWrapper.className = 'annotation annotation-deletion';
      delWrapper.dataset.annotationId = annotation.id;
      delWrapper.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCard(annotation.id);
      });
      wrapRange(range, delWrapper);

    } else if (annotation.type === 'suggestion') {
      var sugWrapper = document.createElement('span');
      sugWrapper.className = 'annotation annotation-suggestion-original';
      sugWrapper.dataset.annotationId = annotation.id;
      sugWrapper.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCard(annotation.id);
      });
      wrapRange(range, sugWrapper);

      // Insert suggested replacement text after the original
      var replacement = document.createElement('span');
      replacement.className = 'annotation annotation-suggestion-replacement';
      replacement.textContent = annotation.body || '';
      replacement.dataset.annotationId = annotation.id;
      sugWrapper.after(replacement);
    }

    // Add card to sidebar
    var sidebar = ensureSidebar();
    var card = createAnnotationCard(annotation);
    sidebar.appendChild(card);

    // Position after a brief delay so DOM has settled
    setTimeout(positionCards, 0);
  }

  // ---------------------------------------------------------------------------
  // Orphaned annotations
  // ---------------------------------------------------------------------------
  function addOrphanedAnnotation(annotation) {
    var container = document.querySelector('.annotation-orphaned-list');
    if (!container) {
      container = document.createElement('div');
      container.className = 'annotation-orphaned-list';
      container.innerHTML = '<h4 class="annotation-orphaned-title">Unresolved Annotations</h4>';
      var nc = noteContainer();
      if (nc) nc.appendChild(container);
    }

    var item = document.createElement('div');
    item.className = 'annotation-orphaned-item';
    item.innerHTML =
      '<span class="annotation-orphaned-quote">"' + escapeHtml(annotation.quote) + '"</span>' +
      '<span class="annotation-orphaned-meta"> — ' + escapeHtml(annotation.author_name) + '</span>' +
      (annotation.body
        ? '<div class="annotation-orphaned-body">' + escapeHtml(annotation.body) + '</div>'
        : '');
    container.appendChild(item);
  }

  // ---------------------------------------------------------------------------
  // API communication
  // ---------------------------------------------------------------------------
  function loadAnnotations(noteId) {
    fetch('/v1/annotations/' + encodeURIComponent(noteId))
      .then(function (res) {
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        var annotations = data.annotations || [];
        // Sort by offset descending so DOM insertions don't shift earlier offsets
        annotations.sort(function (a, b) {
          return (b.quote_offset || 0) - (a.quote_offset || 0);
        });
        annotations.forEach(function (a) {
          renderAnnotation(a);
        });
        // Final reposition after all cards rendered
        setTimeout(positionCards, 50);
      })
      .catch(function (e) {
        console.warn('Failed to load annotations:', e);
      });
  }

  function createAnnotation(noteId, annotationData) {
    var author = getAuthor();

    var doPost = function (authorName) {
      if (!authorName) return Promise.resolve(null);
      annotationData.author_name = authorName;

      return fetch('/v1/annotations/' + encodeURIComponent(noteId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annotationData)
      })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          return data ? data.annotation : null;
        })
        .catch(function (e) {
          console.warn('Failed to create annotation:', e);
          return null;
        });
    };

    if (author) {
      return doPost(author);
    }

    return promptForNickname().then(doPost);
  }

  function deleteAnnotation(noteId, annotation) {
    return fetch('/v1/annotations/' + encodeURIComponent(noteId) + '/' + annotation.id, {
      method: 'DELETE'
    })
      .then(function (res) { return res.ok; })
      .catch(function (e) {
        console.warn('Failed to delete annotation:', e);
        return false;
      });
  }

  function removeAnnotationFromDOM(annotationId) {
    var elements = document.querySelectorAll('[data-annotation-id="' + annotationId + '"]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      // For suggestion replacements, just remove the element entirely
      if (el.classList.contains('annotation-suggestion-replacement')) {
        el.remove();
        continue;
      }
      // For sidebar cards, just remove the element entirely
      if (el.classList.contains('annotation-sidebar-card')) {
        el.remove();
        continue;
      }
      // For other annotation wrappers, unwrap (replace span with its children)
      var parent = el.parentNode;
      while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
      }
      el.remove();
    }
    // Clean up tracking
    delete _renderedIds[annotationId];
    delete _annotationsData[annotationId];

    // Hide sidebar if empty
    if (_sidebarEl && _sidebarEl.querySelectorAll('.annotation-sidebar-card').length === 0) {
      _sidebarEl.remove();
      _sidebarEl = null;
    } else {
      setTimeout(positionCards, 0);
    }
  }

  // ---------------------------------------------------------------------------
  // SSE client
  // ---------------------------------------------------------------------------
  function setupSSE(noteId) {
    var events = new EventSource('/v1/annotations/' + encodeURIComponent(noteId) + '/events');

    events.addEventListener('new-annotation', function (e) {
      try {
        var annotation = JSON.parse(e.data);
        renderAnnotation(annotation);
      } catch (err) {
        console.warn('Failed to parse SSE annotation:', err);
      }
    });

    events.addEventListener('delete-annotation', function (e) {
      try {
        var data = JSON.parse(e.data);
        removeAnnotationFromDOM(data.id);
      } catch (err) {
        console.warn('Failed to parse SSE deletion:', err);
      }
    });

    events.addEventListener('new-reply', function (e) {
      try {
        var data = JSON.parse(e.data);
        var annotationId = data.annotation_id;
        var reply = data.reply;
        if (!_sidebarEl) return;
        var card = _sidebarEl.querySelector('[data-annotation-id="' + annotationId + '"]');
        if (!card) return;
        var thread = card.querySelector('.annotation-card-thread');
        if (!thread) return;
        // Check if reply already rendered
        if (thread.querySelector('[data-reply-id="' + reply.id + '"]')) return;
        var replyEl = createReplyEl(reply);
        var inputRow = thread.querySelector('.annotation-card-reply-input-row');
        thread.insertBefore(replyEl, inputRow);
        updateReplyCount(annotationId);
      } catch (err) {
        console.warn('Failed to parse SSE reply:', err);
      }
    });

    events.onerror = function () {
      console.warn('Annotation SSE connection error, will reconnect...');
    };
  }

  // ---------------------------------------------------------------------------
  // Selection toolbar
  // ---------------------------------------------------------------------------
  function hideToolbar() {
    if (_toolbar) {
      _toolbar.remove();
      _toolbar = null;
    }
  }

  function isInsideAnnotationUI(node) {
    // Walk up and check if inside our toolbar, sidebar, or nickname modal
    var el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      if (el.classList &&
          (el.classList.contains('annotation-toolbar') ||
           el.classList.contains('annotation-sidebar') ||
           el.classList.contains('annotation-nickname-overlay'))) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function showToolbar(noteId) {
    var sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;

    var selText = sel.toString();
    if (!selText || !selText.trim()) return;

    // Don't show toolbar for selections inside our own UI
    var anchorNode = sel.anchorNode;
    if (anchorNode && isInsideAnnotationUI(anchorNode)) return;

    // Only trigger inside the note container
    var container = noteContainer();
    if (!container) return;
    var range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    hideToolbar();

    var rect = range.getBoundingClientRect();

    // Position on the right side of the note container, like Google Docs
    var containerRect = container.getBoundingClientRect();

    var toolbar = document.createElement('div');
    toolbar.className = 'annotation-toolbar';
    toolbar.style.position = 'absolute';
    toolbar.style.top = (rect.top + window.scrollY) + 'px';
    toolbar.style.left = (containerRect.right + 8) + 'px';
    toolbar.style.zIndex = '10001';

    // SVG icons
    var commentIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    var suggestIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    var deleteIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

    // Buttons
    var btnComment = document.createElement('button');
    btnComment.className = 'annotation-toolbar-btn btn-comment';
    btnComment.innerHTML = commentIcon;
    btnComment.type = 'button';
    btnComment.title = 'Add comment';

    var btnSuggest = document.createElement('button');
    btnSuggest.className = 'annotation-toolbar-btn btn-suggest';
    btnSuggest.innerHTML = suggestIcon;
    btnSuggest.type = 'button';
    btnSuggest.title = 'Suggest edit';

    var btnDelete = document.createElement('button');
    btnDelete.className = 'annotation-toolbar-btn btn-delete';
    btnDelete.innerHTML = deleteIcon;
    btnDelete.type = 'button';
    btnDelete.title = 'Mark for deletion';

    toolbar.appendChild(btnComment);
    toolbar.appendChild(btnSuggest);
    toolbar.appendChild(btnDelete);

    document.body.appendChild(toolbar);
    _toolbar = toolbar;

    // Prevent toolbar clicks from clearing selection
    toolbar.addEventListener('mousedown', function (e) {
      e.preventDefault();
    });

    // Prevent toolbar mouseup from re-triggering showToolbar
    toolbar.addEventListener('mouseup', function (e) {
      e.stopPropagation();
    });

    // Capture the selection NOW while it still exists, before any input steals focus
    var savedAnchor = serializeSelection();

    // -- Open a draft card in the sidebar for Comment / Suggest --
    function openDraftCard(placeholder, type) {
      if (!savedAnchor) { hideToolbar(); return; }

      var layer = ensureSidebar();

      // Build a draft card
      var card = document.createElement('div');
      card.className = 'annotation-sidebar-card annotation-draft-card expanded card-type-' + type;

      var quoteEl = document.createElement('div');
      quoteEl.className = 'annotation-card-quote';
      var qt = savedAnchor.quote;
      if (qt.length > 60) qt = qt.slice(0, 60) + '...';
      quoteEl.textContent = '\u201C' + qt + '\u201D';
      card.appendChild(quoteEl);

      var inputRow = document.createElement('div');
      inputRow.className = 'annotation-card-reply-input-row';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'annotation-card-reply-input';
      input.placeholder = placeholder;
      var submitBtn = document.createElement('button');
      submitBtn.className = 'annotation-card-reply-btn';
      submitBtn.textContent = type === 'suggestion' ? 'Suggest' : 'Comment';
      submitBtn.type = 'button';
      inputRow.appendChild(input);
      inputRow.appendChild(submitBtn);
      card.appendChild(inputRow);

      layer.appendChild(card);

      // Position the draft card near the selected text
      var sel = window.getSelection();
      if (sel.rangeCount) {
        var range = sel.getRangeAt(0);
        var scrollParent = layer.parentElement;
        if (scrollParent) {
          var parentRect = scrollParent.getBoundingClientRect();
          var rangeRect = range.getBoundingClientRect();
          card.style.top = (rangeRect.top - parentRect.top + scrollParent.scrollTop) + 'px';
        }
      }

      window.getSelection().removeAllRanges();
      hideToolbar();

      // Focus input after toolbar is removed
      setTimeout(function () { input.focus(); }, 50);

      function doSubmit() {
        var body = input.value.trim();
        if (!body) return;
        var payload = {
          type: type,
          quote: savedAnchor.quote,
          prefix: savedAnchor.prefix,
          suffix: savedAnchor.suffix,
          quote_offset: savedAnchor.quote_offset,
          body: body
        };
        createAnnotation(noteId, payload).then(function (created) {
          // Remove draft card
          card.remove();
          if (created) renderAnnotation(created);
        });
      }

      submitBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        doSubmit();
      });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') doSubmit();
        if (e.key === 'Escape') card.remove();
      });
      input.addEventListener('click', function (e) {
        e.stopPropagation();
      });
      card.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    // -- Button handlers --
    btnComment.addEventListener('click', function (e) {
      e.stopPropagation();
      openDraftCard('Add a comment...', 'comment');
    });

    btnSuggest.addEventListener('click', function (e) {
      e.stopPropagation();
      openDraftCard('Suggest replacement...', 'suggestion');
    });

    btnDelete.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!savedAnchor) {
        hideToolbar();
        return;
      }
      var payload = {
        type: 'deletion',
        quote: savedAnchor.quote,
        prefix: savedAnchor.prefix,
        suffix: savedAnchor.suffix,
        quote_offset: savedAnchor.quote_offset
      };
      createAnnotation(noteId, payload).then(function (created) {
        if (created) renderAnnotation(created);
        window.getSelection().removeAllRanges();
        hideToolbar();
      });
    });
  }

  function setupSelectionToolbar(noteId) {
    document.addEventListener('mouseup', function () {
      // Small delay lets the selection finalize
      setTimeout(function () { showToolbar(noteId); }, 10);
    });

    document.addEventListener('touchend', function () {
      setTimeout(function () { showToolbar(noteId); }, 10);
    });

    // Hide on Escape, Delete/Backspace to mark for deletion
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        hideToolbar();
        return;
      }

      // Delete or Backspace with text selected → mark for deletion
      if (e.key === 'Delete' || e.key === 'Backspace') {
        var sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) return;
        var selText = sel.toString();
        if (!selText || !selText.trim()) return;
        var container = noteContainer();
        if (!container) return;
        var range = sel.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) return;

        e.preventDefault();
        var anchor = serializeSelection();
        if (!anchor) return;

        var payload = {
          type: 'deletion',
          quote: anchor.quote,
          prefix: anchor.prefix,
          suffix: anchor.suffix,
          quote_offset: anchor.quote_offset
        };
        createAnnotation(noteId, payload).then(function (created) {
          if (created) renderAnnotation(created);
          window.getSelection().removeAllRanges();
          hideToolbar();
        });
      }
    });

    // Hide toolbar when clicking outside it (but not when clicking inside it)
    document.addEventListener('mousedown', function (e) {
      if (_toolbar && !_toolbar.contains(e.target)) {
        hideToolbar();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  function initAnnotations() {
    var noteId = document.body.dataset.noteId;
    if (!noteId) return;

    loadAnnotations(noteId);
    setupSelectionToolbar(noteId);
    setupSSE(noteId);
  }

  // Expose globally so it can be called externally if needed
  window.initAnnotations = initAnnotations;

  // Auto-initialize for unencrypted notes.
  // For encrypted notes, decrypt.js calls initAnnotations() after decryption.
  function autoInit() {
    if (!document.getElementById('encrypted-data')) {
      initAnnotations();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})();
