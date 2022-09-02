import path from "path";
import { createHash } from "crypto";
import { DepGraph } from "dependency-graph";
import { Module } from "module";

import { WebC } from "../webc.js";
import { AssetManager } from "./assetManager.js";
import { CssPrefixer } from "./css.js";
import { AttributeSerializer } from "./attributeSerializer.js";

class AstSerializer {
	constructor(options = {}) {
		let { mode, filePath } = Object.assign({
			mode: "component", // or "page"
			filePath: undefined,
		}, options);

		// controls whether or not doctype, html, body are prepended to content
		this.mode = mode;

		// for error messaging
		this.filePath = filePath;

		// content transforms
		this.transforms = {};

		// transform scoped CSS with a hash prefix
		this.addTransform(AstSerializer.transformTypes.SCOPED, (content, component) => {
			let prefixer = new CssPrefixer(component.scopedStyleHash);
			prefixer.setFilePath(component.filePath);
			return prefixer.process(content);
		});

		this.addTransform(AstSerializer.transformTypes.RENDER, async (content, component, data) => {
			let m = new Module();
			// m.paths = module.paths;
			m._compile(content, this.filePath);
			let fn = m.exports;
			return fn(data);
		});

		// Component cache
		this.componentMap = {};
		this.components = {};

		this.hashOverrides = {};
	}

	/* Custom HTML attributes */
	static attrs = {
		TYPE: "webc:type",
		KEEP: "webc:keep",
		RAW: "webc:raw",
		IS: "webc:is",
		ROOT: "webc:root",
		IMPORT: "webc:import", // import another webc inline
		SCOPED: "webc:scoped", // css scoping
	};

	static transformTypes = {
		RENDER: "render",
		SCOPED: "internal:css/scoped",
	}

	// List from the parse5 serializer
	// https://github.com/inikulin/parse5/blob/3955dcc158031cc773a18517d2eabe8b17107aa3/packages/parse5/lib/serializer/index.ts
	static voidElements = {
		area: true,
		base: true,
		basefont: true,
		bgsound: true,
		br: true,
		col: true,
		embed: true,
		frame: true,
		hr: true,
		img: true,
		input: true,
		keygen: true,
		link: true,
		meta: true,
		param: true,
		source: true,
		track: true,
		wbr: true,
	};

	addTransform(name, callback) {
		this.transforms[name] = callback;
	}

	isVoidElement(tagName) {
		return AstSerializer.voidElements[tagName] || false;
	}

	hasAttribute(node, attributeName) {
		return (node.attrs || []).find(({name}) => name === attributeName) !== undefined;
	}

	getAttributeValue(node, attributeName) {
		let nameAttr = (node.attrs || []).find(({name}) => name === attributeName);

		if(!nameAttr) {
			// Same as Element.getAttribute
			// https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttribute
			return null;
		}

		return nameAttr?.value;
	}

	findElement(root, tagName, attrCheck = []) {
		let rootTagName = this.getTagName(root);
		if(rootTagName === tagName) {
			if(attrCheck.length === 0 || attrCheck.find(attr => this.hasAttribute(root, attr))) {
				return root;
			}
		}
		for(let child of root.childNodes || []) {
			let node = this.findElement(child, tagName, attrCheck);
			if(node) {
				return node;
			}
		}
	}

	findAllChildren(parentNode, tagNames = [], attrCheck = []) {
		if(!parentNode) {
			return [];
		}
		if(typeof tagNames === "string") {
			tagNames = [tagNames];
		}
		if(!tagNames || Array.isArray(tagNames)) {
			tagNames = new Set(tagNames);
		}

		let results = [];
		for(let child of parentNode.childNodes || []) {
			let tagName = this.getTagName(child);
			if(tagNames.size === 0 || tagNames.has(tagName)) {
				if(attrCheck.length === 0 || attrCheck.find(attr => this.hasAttribute(child, attr))) {
					results.push(child);
				}
			}
		}
		return results;
	}

	getTextContent(node) {
		let content = [];
		for(let child of node.childNodes || []) {
			if(child.nodeName === "#text") {
				content.push(child.value);
			}
		}
		return content;
	}

	hasTextContent(node) {
		return this.getTextContent(node).find(entry => entry.trim().length > 0) !== undefined;
	}

	getScopedStyleHash(component, filePath) {
		let prefix = "w";
		let hashLength = 8;
		let hash = createHash("sha256");
		let body = this.findElement(component, "body");

		// <style webc:scoped> must be nested at the root
		let styleNodes = this.findAllChildren(body, "style", [AstSerializer.attrs.SCOPED]);
		for(let node of styleNodes) {
			// Override hash with scoped="override"
			let override = this.getAttributeValue(node, AstSerializer.attrs.SCOPED);
			if(override) {
				if(this.hashOverrides[override]) {
					if(this.hashOverrides[override] !== filePath) {
						throw new Error(`You have \`webc:scoped\` override collisions! See ${this.hashOverrides[override]} and ${filePath}`);
					}
				} else {
					this.hashOverrides[override] = filePath;
				}

				return override;
			}
			hash.update(this.getTextContent(node).toString());
		}

		if(styleNodes.length) { // don’t return a hash if empty
			return prefix + hash.digest("base64url").toLowerCase().slice(0, hashLength);
		}
	}

	ignoreComponentParentTag(component) {
		let body = this.findElement(component, "body");

		// Has <* webc:root> (has to be a root child, not script/style)
		let roots = this.findAllChildren(body, [], [AstSerializer.attrs.ROOT]);
		for(let child of roots) {
			let tagName = this.getTagName(child);
			if(tagName === "script" || tagName === "style") {
				continue;
			}

			if(this.hasAttribute(child, AstSerializer.attrs.ROOT)) {
				return false;
			}
		}

		// do not ignore if <style> or <script> in component definition (unless <style webc:root> or <script webc:root>)
		let children = this.findAllChildren(body, ["script", "style"]);
		for(let child of children) {
			if(!this.hasAttribute(child, AstSerializer.attrs.ROOT) && this.hasTextContent(child)) {
				return false;
			}
		}

		// Has <template shadowroot> (can be anywhere in the tree)
		let shadowroot = this.findElement(body, "template", ["shadowroot"]);
		if(shadowroot) {
			return false;
		}

		return true;
	}

	isIgnored(node, component) {
		let tagName = this.getTagName(node);

		if(this.hasAttribute(node, AstSerializer.attrs.KEEP)) {
			// do not ignore
			return false;
		}

		if(this.hasAttribute(node, AstSerializer.attrs.ROOT)) {
			return true;
		}

		// Must come after webc:keep (takes precedence)
		if(this.hasAttribute(node, AstSerializer.attrs.TYPE)) {
			return true;
		}

		if(!component) {
			component = this.getComponent(tagName);
		}
		if(component?.ignoreRootTag) {
			// do not include the parent element if this component has no styles or script associated with it
			return true;
		}

		if(this.mode === "component") {
			if(tagName === "head" || tagName === "body" || tagName === "html") {
				return true;
			}
		}

		if(tagName === "slot") {
			return true;
		}

		// aggregation tags
		if(tagName === "style" || tagName === "script") {
			return true;
		}

		return false;
	}

	// Allow options.slots to be strings
	async getSlotAst(slot) {
		if(typeof slot === "string") {
			return WebC.getASTFromString(slot);
		}
		return slot;
	}

	getRootNodes(node) {
		let body = this.findElement(node, "body");
		return this.findAllChildren(body, [], [AstSerializer.attrs.ROOT]);
	}

	getRootAttributes(component, scopedStyleHash) {
		let attrs = [];
		let roots = this.getRootNodes(component);
		for(let root of roots) {
			for(let attr of root.attrs.filter(entry => entry.name !== AstSerializer.attrs.ROOT)) {
				attrs.push(attr);
			}
		}

		if(scopedStyleHash) {
			// it’s okay if there are other `class` attributes, we merge them later
			attrs.push({ name: "class", value: scopedStyleHash });
		}

		return attrs;
	}

	async precompileComponent(filePath, ast) {
		// Async-caching here could be better?
		if(this.components[filePath]) {
			return;
		}

		if(!ast) {
			ast = await WebC.getASTFromFilePath(filePath);
		}
		let scopedStyleHash = this.getScopedStyleHash(ast, filePath);

		this.components[filePath] = {
			filePath,
			ast,
			ignoreRootTag: this.ignoreComponentParentTag(ast),
			scopedStyleHash,
			rootAttributes: this.getRootAttributes(ast, scopedStyleHash),
		};
	}

	// synchronous (components should already be cached)
	getComponent(name) {
		if(!name || !this.componentMap[name]) {
			// render as a plain-ol-tag
			return false;
		}

		let filePath = this.componentMap[name];
		if(!this.components[filePath]) {
			throw new Error(`Component at "${filePath}" not found in the component registry.`);
		}
		return this.components[filePath];
	}

	// `components` object maps from component name => filename
	async setComponents(components = {}) {
		Object.assign(this.componentMap, components || {});

		// precompile components
		let promises = [];
		for(let name in components) {
			promises.push(this.precompileComponent(components[name]));
		}
		await Promise.all(promises);
	}

	async getChildContent(parentNode, slots, options) {
		let promises = [];
		for(let child of parentNode.childNodes || []) {
			promises.push(this.compileNode(child, slots, options))
		}
		let p = await Promise.all(promises);
		let html = p.map(entry => entry.html).join("");

		return {
			html,
		};
	}

	getSlotNodes(node, slots = {}) {
		let defaultSlot = [];
		for(let child of node.childNodes) {
			let slotName = this.getAttributeValue(child, "slot");
			if(slotName) {
				slots[slotName] = child;
			} else {
				defaultSlot.push(child);
			}
		}
		// faking a real AST by returning an object with childNodes
		slots.default = { childNodes: defaultSlot };
		return slots;
	}

	getTagName(node) {
		let is = this.getAttributeValue(node, AstSerializer.attrs.IS);
		if(is) {
			return is;
		}

		return node.tagName;
	}

	getAttributes(node, component, options) {
		let attrs = node.attrs.slice(0);

		// If this is a top level page-component, make sure we get the top level attributes here
		if(!component && this.filePath === options.closestParentComponent && this.components[this.filePath]) {
			component = this.components[this.filePath];
		}

		if(component && Array.isArray(component.rootAttributes)) {
			attrs.push(...component.rootAttributes);
		}

		return attrs;
	}

	renderStartTag(node, tagName, slotSource, component, options) {
		let content = "";
		let attrObject;

		if(tagName) {
			// parse5 doesn’t preserve whitespace around <html>, <head>, and after </body>
			if(this.mode === "page" && tagName === "head") {
				content += `\n`;
			}

			let attrs = this.getAttributes(node, component, options);
			attrObject = AttributeSerializer.dedupeAttributes(attrs);

			if(options.rawMode || !this.isIgnored(node, component, options) && !slotSource) {
				content += `<${tagName}${AttributeSerializer.getString(attrObject, options.componentAttributes)}>`;
			}
		}

		return {
			content,
			attrs: attrObject
		};
	}

	renderEndTag(node, tagName, slotSource, component, options) {
		let content = "";
		if(tagName) {
			if(this.isVoidElement(tagName)) {
				// do nothing: void elements don’t have closing tags
			} else if(options.rawMode || !this.isIgnored(node, component, options) && !slotSource) {
				content += `</${tagName}>`;
			}

			if(this.mode === "page" && tagName === "body") {
				content += `\n`;
			}
		}
		return content;
	}

	async transformContent(content, transformType, parentComponent, options) {
		if(transformType) {
			return this.transforms[transformType](content, parentComponent, options.componentAttributes);
		}
		return content;
	}

	async importComponent(filePath) {
		let parsed = path.parse(this.filePath);
		let relativeFromRoot = path.join(parsed.dir, filePath);
		let finalFilePath = `.${path.sep}${relativeFromRoot}`;

		await this.precompileComponent(finalFilePath);

		return this.components[finalFilePath];
	}

	async getContentForSlot(node, slots, options) {
		let slotName = this.getAttributeValue(node, "name") || "default";
		if(slots[slotName]) {
			let slotAst = await this.getSlotAst(slots[slotName]);
			let { html: slotHtml } = await this.getChildContent(slotAst, null, options);
			return slotHtml;
		}

		// Use fallback content in <slot> if no slot source exists to fill it
		let { html: slotFallbackHtml } = await this.getChildContent(node, null, options);
		return slotFallbackHtml;
	}

	async getContentForTemplate(node, slots, options, attrs) {
		let templateOptions = Object.assign({}, options);
		templateOptions.rawMode = true;
		delete templateOptions.currentTransformType;

		let { html: rawContent } = await this.compileNode(node.content, slots, templateOptions);
		// Get plaintext from <template> .content
		if(options.currentTransformType) {
			return this.transformContent(rawContent, options.currentTransformType, this.components[options.closestParentComponent], options);
		}
		return rawContent;
	}

	// Transforms can alter HTML content e.g. <template webc:type="markdown">
	getTransformType(node) {
		let transformType = this.getAttributeValue(node, AstSerializer.attrs.TYPE);
		if(this.hasAttribute(node, AstSerializer.attrs.SCOPED)) {
			transformType = AstSerializer.transformTypes.SCOPED;
		}
		if(transformType && !!this.transforms[transformType]) {
			return transformType;
		}
	}

	addComponentDependency(component, tagName, options) {
		let componentFilePath = component.filePath;
		if(!options.components.hasNode(componentFilePath)) {
			options.components.addNode(componentFilePath);
		}

		if(options.closestParentComponent) {
			// Slotted content is not counted for circular dependency checks (semantically it is an argument, not a core dependency)
			// <web-component><child/></web-component>
			if(!options.isSlotContent) {
				if(options.closestParentComponent === componentFilePath || options.components.dependantsOf(options.closestParentComponent).find(entry => entry === componentFilePath) !== undefined) {
					throw new Error(`Circular dependency error: You cannot use <${tagName}> inside the definition for ${options.closestParentComponent}`);
				}
			}

			options.components.addDependency(options.closestParentComponent, componentFilePath);
		}

		// reset for next time
		options.closestParentComponent = componentFilePath;
	}

	async compileNode(node, slots = {}, options = {}) {
		options = Object.assign({}, options);

		let tagName = this.getTagName(node);
		let content = "";

		let transformType = this.getTransformType(node);
		if(transformType) {
			options.currentTransformType = transformType;
		}

		if(this.hasAttribute(node, AstSerializer.attrs.RAW)) {
			options.rawMode = true;
		}

		let component;
		let importSource = this.getAttributeValue(node, AstSerializer.attrs.IMPORT);
		if(importSource) {
			component = await this.importComponent(importSource);
		} else {
			component = this.getComponent(tagName);
		}

		let slotSource = this.getAttributeValue(node, "slot");
		if(slotSource) {
			options.isSlotContent = true;
		}

		// TODO warning if top level page component using a style hash but has no root element

		// Start tag
		let { content: startTagContent, attrs } = this.renderStartTag(node, tagName, slotSource, component, options);
		content += startTagContent;

		// Component content (foreshadow dom)
		let componentHasContent = null;
		if(component) {
			options.componentAttributes = attrs;
		}

		if(!options.rawMode && component) {
			this.addComponentDependency(component, tagName, options);

			let slots = this.getSlotNodes(node);
			let { html: foreshadowDom } = await this.compileNode(component.ast, slots, options);
			componentHasContent = foreshadowDom.trim().length > 0;

			content += foreshadowDom;
		}

		// Skip the remaining content is we have foreshadow dom!
		if(!componentHasContent) {
			if(node.nodeName === "#text") {
				content += await this.transformContent(node.value, options.currentTransformType, this.components[options.closestParentComponent], options);
			} else if(node.nodeName === "#comment") {
				content += `<!--${node.data}-->`;
			} else if(this.mode === "page" && node.nodeName === "#documentType") {
				content += `<!doctype ${node.name}>\n`;
			}

			if(!options.rawMode && tagName === "slot") { // <slot> node
				options.isSlotContent = true;

				content += await this.getContentForSlot(node, slots, options);
			} else if(!options.rawMode && slotSource) {
				// do nothing if this is a <tag slot=""> attribute source: do not add to compiled content
			} else if(node.content) { // <template> content
				content += await this.getContentForTemplate(node, slots, options, attrs);
			} else if(node.childNodes?.length > 0) {
				// Fallback to light DOM if no component dom exists
				if(componentHasContent === false) {
					options.isSlotContent = true;
				}

				let { html: childContent } = await this.getChildContent(node, slots, options);

				if(options.rawMode || tagName === "template" && options.currentTransformType) {
					content += childContent;
				} else {
					// aggregate CSS and JS
					let key = {
						style: "css",
						script: "js",
					}[ tagName ];

					if(key && !this.hasAttribute(node, AstSerializer.attrs.KEEP)) {
						let entryKey = options.closestParentComponent || this.filePath;
						if(!options[key][entryKey]) {
							options[key][entryKey] = new Set();
						}
						options[key][entryKey].add( childContent );
					} else {
						content += childContent;
					}
				}
			}
		}

		// End tag
		content += this.renderEndTag(node, tagName, slotSource, component, options);

		return {
			html: content,
		}
	}

	async compile(node, slots = {}, options = {}) {
		options = Object.assign({
			rawMode: false,
			isSlotContent: false,
			css: {},
			js: {},
			components: new DepGraph({ circular: true }),
			closestParentComponent: this.filePath,
		}, options);

		// Precompile the top level component
		if(this.filePath) {
			if(!this.components[this.filePath]) {
				await this.precompileComponent(this.filePath, node);
			}

			options.components.addNode(this.filePath);
		}

		let compiled = await this.compileNode(node, slots, options);
		let content = compiled.html;
		let assets = new AssetManager(options.components);

		let ret = {
			html: content,
			css: assets.getOrderedAssets(options.css),
			js: assets.getOrderedAssets(options.js),
			components: assets.orderedComponentList,
		};
		return ret;
	}
}

export { AstSerializer };