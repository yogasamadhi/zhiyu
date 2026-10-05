'use strict';

// Local fix for GHSA-vfj7-8cjw-p6xm. Validate caller-supplied ASTs before
// entering upstream's recursive walkers; parsed strings are bounded as well.
module.exports = input => {
  const pending = [{ node: input, depth: 0 }];
  const visited = new WeakSet();
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 100) throw new SyntaxError('Maximum brace nesting depth exceeded (100)');
    if (visited.has(node)) throw new SyntaxError('Cyclic or repeated brace AST node');
    visited.add(node);
    if (++count > 65536) throw new SyntaxError('Maximum brace AST size exceeded');
    if (node.nodes) {
      if (!Array.isArray(node.nodes)) throw new TypeError('Brace AST nodes must be an array');
      if (node.nodes.length + pending.length > 65536) throw new SyntaxError('Maximum brace AST size exceeded');
      for (const child of node.nodes) pending.push({ node: child, depth: depth + 1 });
    }
  }
};
