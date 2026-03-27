var api = {};

var Module = {
    onRuntimeInitialized: function() {
        /* Document */
        api.document_create = Module.cwrap('wasm_document_create', 'number', []);
        api.document_destroy = Module.cwrap('wasm_document_destroy', null, ['number']);
        api.document_parse = Module.cwrap('wasm_document_parse', 'number', ['number', 'number', 'number']);
        api.document_destroy_string = Module.cwrap('wasm_document_destroy_string', null, ['number', 'number']);

        /* Document Settings */
        api.document_opt_set = Module.cwrap('wasm_document_opt_set', null, ['number', 'number']);
        api.document_opt_get = Module.cwrap('wasm_document_opt_get', 'number', ['number']);
        api.document_scripting_set = Module.cwrap('wasm_document_scripting_set', null, ['number', 'boolean']);

        /* Node */
        api.node_destroy_string = Module.cwrap('wasm_node_destroy_string', null, ['number', 'number']);

        /* Style */
        api.document_style_init = Module.cwrap('wasm_document_style_init', 'number', ['number']);
        api.document_style_destroy = Module.cwrap('wasm_document_style_destroy', null, ['number']);

        /* CSS Parser */
        api.css_parser_create = Module.cwrap('wasm_css_parser_create', 'number', []);
        api.css_parser_destroy = Module.cwrap('wasm_css_parser_destroy', null, ['number']);
        api.css_parse_selectors = Module.cwrap('wasm_css_parse_selectors', 'number', ['number', 'string', 'number']);
        api.css_selector_list_destroy = Module.cwrap('wasm_css_selector_list_destroy', null, ['number']);
        api.css_memory_destroy = Module.cwrap('wasm_css_memory_destroy', null, ['number']);

        /* Selectors */
        api.selectors_create = Module.cwrap('wasm_selectors_create', 'number', []);
        api.selectors_destroy = Module.cwrap('wasm_selectors_destroy', null, ['number']);
        api.selectors_context_create = Module.cwrap('wasm_selectors_context_create', 'number', []);
        api.selectors_context_clean = Module.cwrap('wasm_selectors_context_clean', null, ['number']);
        api.selectors_context_destroy = Module.cwrap('wasm_selectors_context_destroy', null, ['number']);
        api.selectors_context_count = Module.cwrap('wasm_selectors_context_count', 'number', ['number']);
        api.selectors_context_get_node = Module.cwrap('wasm_selectors_context_get_node', 'number', ['number', 'number']);
        api.selectors_match = Module.cwrap('wasm_selectors_match', 'number', ['number', 'number', 'number', 'number']);

        /* Serialize */
        api.document_serialize = Module.cwrap('wasm_document_serialize', 'number', ['number', 'number', 'boolean']);
        api.document_serialize_opt_to_str = Module.cwrap('wasm_document_serialize_opt_to_str', 'string', ['number']);

        if (typeof onLexborReady === 'function') {
            onLexborReady(api);
        }
    }
};

class LexborDomNode {
    constructor(api, ptr) {
        this.ptr = ptr;
        this.api = api;
    }

    pointer = () => {
        return this.ptr;
    }

    serialize = (opt, as_tree) => {
        let resultPtr = this.api.document_serialize(this.ptr, opt, as_tree);
        let result = Module.UTF8ToString(resultPtr);

        this.api.node_destroy_string(this.ptr, resultPtr);

        return result;
    }

    idOpen = () => {
        return 'o-' + this.ptr;
    }

    idClose = () => {
        return 'c-' + this.ptr;
    }
}

class Lexbor {
    constructor(api) {
        /* Create a new document. */
        this.doc = api.document_create();
        this.doc_node = new LexborDomNode(api, this.doc);

        /* Initialize styles. */
        this.style = api.document_style_init(this.doc);

        /* Create a CSS parser. */
        this.css_parser = api.css_parser_create();

        /* Create Selectors. */
        this.selectors = api.selectors_create();

        /* Create a selectors context. */
        this.selectors_context = api.selectors_context_create();

        this.api = api;
    }

    parse = (html) => {
        let size = Module.lengthBytesUTF8(html) + 1;
        let ptr = Module._malloc(size);

        if (!ptr) {
            throw new Error('Failed to allocate memory for HTML input.');
        }

        Module.stringToUTF8(html, ptr, size);

        try {
            let status = this.api.document_parse(this.doc, ptr, size - 1);
            if (status != 0) {
                throw new Error('Parse error (status: ' + status + ')');
            }
        } catch (e) {
            throw new Error('Failed to parse HTML: ' + e.message);
        } finally {
            Module._free(ptr);
        }

        return this.doc_node;
    }

    querySelectorAll = (node, selectors) => {
        if (!node) {
            node = this.doc;
        }
        else if (node instanceof LexborDomNode) {
            node = node.pointer();
        }

        this.api.selectors_context_clean(this.selectors_context);

        /* Parse the selectors. */
        let list = this.api.css_parse_selectors(this.css_parser,
                                                selectors,
                                                Module.lengthBytesUTF8(selectors));
        /* Match selectors. */
        let status = this.api.selectors_match(this.selectors, list, node,
                                              this.selectors_context);
        if (status != 0) {
            console.error('Error matching selectors: ', status);
        }

        /* Clean up resources. */
        this.api.css_selector_list_destroy(list);

        let result = [];
        let count = this.api.selectors_context_count(this.selectors_context);

        for (let i = 0; i < count; i++) {
            let nodePtr = this.api.selectors_context_get_node(this.selectors_context, i);
            result.push(new LexborDomNode(this.api, nodePtr));
        }

        return result;
    }

    foundCount = () => {
        return this.api.selectors_context_count(this.selectors_context);
    }

    destroy = () => {
        this.api.selectors_context_destroy(this.selectors_context);
        this.api.selectors_destroy(this.selectors);
        this.api.css_memory_destroy(this.css_parser);
        this.api.css_parser_destroy(this.css_parser);
        this.api.document_style_destroy(this.doc);
        this.api.document_destroy(this.doc);
    }
}

function serializeOptions(api) {
    let s_str = api.document_serialize_opt_to_str;
    let result = [];

    for (let i = 0; i < 32; i++) {
        let mask = 1 << i;
        let name = s_str(mask);

        if (name && name != 'Pretty') {
            result.push([mask, name]);
        }
    }

    return result;
}

function optOptions(api, activeMask) {
    activeMask = activeMask || 0;

    let options = serializeOptions(api);
    let container = document.querySelector('.serialize-opts');

    let optionTree = optOptionTree();
    let expandedTreeOption = optOptionExpandedTree();

    optionTree.firstChild.addEventListener('change', function() {
        if (this.checked) {
            expandedTreeOption.firstChild.disabled = false;
        }
        else {
            expandedTreeOption.firstChild.disabled = true;
        }
    });

    container.innerHTML = '';
    container.appendChild(optionTree);
    container.appendChild(expandedTreeOption);

    for (let [mask, name] of options) {
        let check = document.createElement('input');
        let label = document.createElement('label');

        check.type = 'checkbox';
        check.value = mask;
        check.classList.add('serialize-opt');
        check.checked = (activeMask & mask) !== 0;

        label.appendChild(check);
        label.appendChild(document.createTextNode(name));

        container.appendChild(label);
    }
}

function optOptionTree() {
    let check = document.createElement('input');
    let label = document.createElement('label');

    check.id = 'tree-opt';
    check.type = 'checkbox';
    check.value = 1;
    check.classList.add('tree-opt');
    check.checked = true;

    label.appendChild(check);
    label.appendChild(document.createTextNode("Tree format"));

    return label;
}

function optOptionExpandedTree() {
    let check = document.createElement('input');
    let label = document.createElement('label');

    check.id = 'tree-expanded-opt';
    check.type = 'checkbox';
    check.value = 1;
    check.classList.add('tree-expanded-opt');
    check.checked = false;

    label.appendChild(check);
    label.appendChild(document.createTextNode("Expanded"));

    return label;
}
