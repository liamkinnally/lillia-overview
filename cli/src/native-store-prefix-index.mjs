// One reconstruction owns this index. It contains no cross-operation cache.
export class PrefixIndex {
  constructor(tree, descriptors, limits, check) {
    this.tree = tree;
    this.descriptors = descriptors;
    this.limits = limits;
    this.check = check;
    this.names = new Map();
    this.total = 0;
  }
  prefixes(path, visit) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix += (i ? '/' : '') + parts[i];
      visit(prefix.toLowerCase(), (i < parts.length - 1 ? 'd:' : 'f:') + prefix);
    }
  }
  remove(entry) {
    this.prefixes(entry.path, (key) => {
      const record = this.names.get(key);
      if (--record.count === 0) this.names.delete(key);
    });
    this.total -= this.descriptors.get(entry.fileId).size;
    this.tree.delete(entry.path);
  }
  add(entry) {
    this.prefixes(entry.path, (key, value) => {
      const prior = this.names.get(key);
      this.check(!prior || prior.value === value, 'Native path case or directory collision');
      if (prior) prior.count++;
      else this.names.set(key, { value, count: 1 });
    });
    this.total += this.descriptors.get(entry.fileId).size;
    this.tree.set(entry.path, entry);
  }
  apply(revision) {
    // Validate against the incoming manifest, then remove every edited old path
    // before adding any final path. Intermediate spelling/type conflicts do not
    // invalidate a legal simultaneous rename or file/directory conversion.
    const prior = revision.edits.map((edit) => {
      const old = this.tree.get(edit.path);
      if (edit.delete) this.check(old, 'Native deletion refers to an absent path');
      else {
        this.check(
          old?.mode !== edit.mode || old?.fileId !== edit.fileId,
          'Native changeset includes a redundant replacement'
        );
        const descriptor = this.descriptors.get(edit.fileId);
        this.check(
          descriptor && (edit.mode !== '120000' || descriptor.link),
          'Unsupported native symlink target bytes'
        );
      }
      return old;
    });
    for (const old of prior) if (old) this.remove(old);
    for (const edit of revision.edits) if (!edit.delete) this.add(edit);
    this.check(this.tree.size <= this.limits.files, 'Native tree exceeds path capacity');
    this.check(this.total <= this.limits.tree, 'Native tree exceeds logical byte capacity');
    return () => {
      for (const edit of revision.edits) if (!edit.delete) this.remove(edit);
      for (const old of prior) if (old) this.add(old);
    };
  }
}
