let lexbor, foundNodes;
let selectorTimer = null;

document.getElementById('file-input').addEventListener('change', function() {
    let file = this.files[0];
    if (!file) return;

    let reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('inputHTML').value = e.target.result;
    };
    reader.readAsText(file);
});

class LiNode {
    constructor(node) {
        let ptr = node.id.replace(/^o-|^c-/, '');
        let tag = node.querySelector("span.element");
        let close = node.parentNode.querySelector('li[id="c-' + ptr + '"]');
        let arrow = node.firstChild;

        this.ptr = ptr;
        this.node = node;
        this.nodeArrow = arrow;
        this.nodeTag = tag;
        this.nodeClose = close;

        if (this.hasChildren()) {
            node.classList.add('has-children');

            this.collapse();
            this.arrowListener();

            return;
        }

        this.single();
    }

    static create(node) {
        if (!node || !node.id || !node.id.startsWith('o-')
            || !node.querySelector("span.element"))
        {
            return null;
        }

        return new LiNode(node);
    }

    pointer = () => {
        return this.ptr;
    }

    hasChildren = () => {
        return this.node.querySelector("ul") !== null;
    }

    nestedUlAll = () => {
        return this.node.querySelectorAll("ul");
    }

    makeCloseTail = (single) => {
        if (this.closeTail) {
            return this.closeTail;
        }

        let tag = this.nodeTag;
        let tail = document.createElement('span');

        if (this.nodeClose) {
            if (!single) {
                tail.className = 'collapsed-tail';
                tail.textContent = '...' + this.nodeClose.textContent;
            }
            else {
                tail.className = 'single-tail';
                tail.innerHTML = this.nodeClose.innerHTML;
            }
        }

        this.closeTail = tail;

        return tail;
    }

    arrowListener = () => {
        this.nodeArrow.addEventListener('click', () => {
            this.toggle();
        });
    }

    appendCloseTail = (single) => {
        let tail = this.makeCloseTail(single);

        if (!tail.parentNode) {
            this.nodeTag.after(tail);
            this.nodeClose?.classList.add('close-collapsed');
        }
    }

    removeCloseTail = () => {
        if (this.closeTail) {
            this.closeTail.remove();
            this.nodeClose?.classList.remove('close-collapsed');
        }
    }

    collapse = () => {
        if (!this.hasChildren()) {
            return;
        }

        let node = this.node;
        let classList = node.classList;

        classList.add('collapsed');
        classList.add('has-children');

        this.appendCloseTail();
    }

    expand = () => {
        if (!this.hasChildren()) {
            return;
        }

        let node = this.node;
        let classList = node.classList;

        classList.remove('collapsed');
        this.removeCloseTail();
    }

    toggle = () => {
        if (this.node.classList.contains('collapsed')) {
            this.expand();
            return false;
        }

        this.collapse();
        return true;
    }

    single = () => {
        if (this.hasChildren()) {
            return;
        }

        let node = this.node;
        let nodeClose = this.nodeClose;

        if (!nodeClose) {
            return;
        }

        nodeClose.classList.add('close-collapsed');
        this.appendCloseTail(true);
    }
}

function initTree(container, expanded) {
    container.querySelectorAll("ul > li:not([id ^= 'c-' i]).element").forEach(li => {
        let node = LiNode.create(li);
        if (!node) {
            return;
        }

        if (expanded) {
            node.expand();
        } else {
            node.collapse();
        }

        li.myNode = node;
    });
}

function doParse() {
    doDestroy();

    let html = document.getElementById('inputHTML').value;
    let output = document.getElementById('outputHTML');
    let treeOpt = document.getElementById('tree-opt');
    let treeExpandedOpt = document.getElementById('tree-expanded-opt');

    lexbor = new Lexbor(api);

    let doc;
    try {
        doc = lexbor.parse(html);
    } catch (e) {
        output.textContent = e.message;
        return;
    }

    let opt = getOptions();
    let out = doc.serialize(opt, treeOpt.checked);

    if (!treeOpt.checked) {
        output.classList.add('pre-text');
    }
    else {
        output.classList.remove('pre-text');
    }

    output.style.display = 'none';
    output.innerHTML = out;

    initTree(output, treeExpandedOpt.checked);

    output.style.display= 'block';

    document.getElementById('selector-input').addEventListener('input', function() {
        let selector = this.value.trim();

        if (selectorTimer) {
            offHighlight(foundNodes);
            clearTimeout(selectorTimer);
        }

        selectorTimer = setTimeout(() => {
            foundNodes = lexbor.querySelectorAll(doc, selector);
            onHighlight(foundNodes);
        }, 150);
    });
}

function doDestroy() {
    if (lexbor) {
        lexbor.destroy();
        lexbor = null;
    }

    document.getElementById('outputHTML').innerHTML = '';
}

function getOptions() {
    let options = document.querySelectorAll('.serialize-opt');
    let result = 0;

    options.forEach(opt => {
        if (opt.checked) {
            result |= parseInt(opt.value);
        }
    });

    return result;
}

function onHighlight(nodes) {
    var outputEl = document.getElementById('outputHTML');
    var countEl = document.getElementById('match-count');

    countEl.textContent = nodes.length + ' match' + (nodes.length !== 1 ? 'es' : '');

    for (let node of nodes) {
        let nodePtr = node.pointer();

        /* Find the corresponding <li> in the output tree */
        let liOpen = outputEl.querySelector('[id="' + node.idOpen() + '"]');
        if (liOpen) {
            liOpen.classList.add('highlight-block');
            liOpen.classList.add('selected');
        }

        let liClose = outputEl.querySelector('[id="' + node.idClose() + '"]');
        if (liClose) {
            liClose.classList.add('highlight-block');
            liClose.classList.add('selected');
        }

        let treeOpt = document.getElementById('tree-opt');

        if (treeOpt.checked) {
            selectorExpandTo(liOpen);
        }
    }
}

function offHighlight(nodes) {
    var outputEl = document.getElementById('outputHTML');

    for (let node of nodes || []) {
        let nodePtr = node.pointer();

        /* Find the corresponding <li> in the output tree */
        let liOpen = outputEl.querySelector('[id="' + node.idOpen() + '"]');
        if (liOpen) {
            liOpen.classList.remove('highlight-block');
            liOpen.classList.remove('selected');
        }

        let liClose = outputEl.querySelector('[id="' + node.idClose() + '"]');
        if (liClose) {
            liClose.classList.remove('highlight-block');
            liClose.classList.remove('selected');
        }
    }
}

function selectorExpandTo(node) {
    let parent = node.parentNode;

    while (parent) {
        if (parent.myNode) {
            parent.myNode.expand();
        }

        parent = parent.parentNode;
    }
}

function onLexborReady(api) {
    optOptions(api);
}
