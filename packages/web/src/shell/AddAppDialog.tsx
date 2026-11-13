import { useEffect, useState, type DragEvent } from 'react';
import { api, messageOf } from '../api/client';
import type { Group, Launchpad } from '../api/types';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Field, Segments } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { navigate } from '../lib/router';

type Mode = 'archive' | 'git' | 'link';

const TABS: { id: Mode; label: string }[] = [
  { id: 'archive', label: 'Archive' },
  { id: 'git', label: 'Git repository' },
  { id: 'link', label: 'External link' },
];

const REVIEW_NOTE =
  'Nothing goes live at this step: the version is checked, started in an isolated preview, then waits for your review.';
const LINK_NOTE =
  'The link appears at once on the launchpad of everyone signed in and opens in a new tab. No code is installed: it does not go through review.';

function Dropzone({ file, onPick }: { file: File | null; onPick: (file: File | null) => void }) {
  const [over, setOver] = useState(false);
  const hover = (value: boolean) => (event: DragEvent) => {
    event.preventDefault();
    setOver(value);
  };
  const drop = (event: DragEvent) => {
    hover(false)(event);
    onPick(event.dataTransfer.files[0] ?? null);
  };
  return (
    <label
      className={`dropzone ${over ? 'over' : ''}`.trim()}
      onDragEnter={hover(true)}
      onDragOver={hover(true)}
      onDragLeave={hover(false)}
      onDrop={drop}
    >
      <Icon name="upload" />
      <strong>{file ? file.name : 'Drop an archive'}</strong>
      <span className="sub">.zip or .tar.gz, with an app.manifest.yaml at the root</span>
      <input
        className="sr-only"
        type="file"
        accept=".zip,.tar.gz,.tgz,.tar"
        aria-label="App archive"
        onChange={(event) => onPick(event.target.files?.[0] ?? null)}
      />
    </label>
  );
}

interface Props {
  onClose: () => void;
  onLinkAdded: () => void;
}

// Three ways to add something to the launchpad. Only an archive or a repository carries code, and goes to review.
export function AddAppDialog({ onClose, onLinkAdded }: Props) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('archive');
  const [file, setFile] = useState<File | null>(null);
  const [git, setGit] = useState({ url: '', ref: '' });
  const [link, setLink] = useState({ name: '', url: '', group: '' });
  const [groups, setGroups] = useState<Group[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api<Launchpad>('/api/launchpad').then(
      (launchpad) => setGroups(launchpad.groups),
      () => {},
    );
  }, []);

  const ready = { archive: Boolean(file), git: Boolean(git.url.trim()), link: Boolean(link.name.trim() && link.url.trim()) }[
    mode
  ];

  const send = async () => {
    if (mode === 'link') {
      await api('/api/links', {
        method: 'POST',
        body: { name: link.name.trim(), url: link.url.trim(), group: link.group || null },
      });
      toast('Link added');
      onLinkAdded();
      return navigate('/apps');
    }
    let created: { id: string };
    if (mode === 'archive') {
      const form = new FormData();
      form.append('archive', file!);
      created = await api('/api/releases/archive', { method: 'POST', form });
    } else {
      created = await api('/api/releases/git', {
        method: 'POST',
        body: { url: git.url.trim(), ref: git.ref.trim() || undefined },
      });
    }
    navigate(`/review/${created.id}`);
  };

  const submit = async () => {
    setSending(true);
    try {
      await send();
      onClose();
    } catch (error) {
      toast(messageOf(error), 'error');
      setSending(false);
    }
  };

  return (
    <Dialog label="Add an app" onClose={onClose}>
      <div className="dialog-body">
        <div className="dialog-head">
          <h2>Add an app</h2>
          <button className="btn ghost small" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="cross" />
          </button>
        </div>
        <Segments className="dialog-tabs" tabs={TABS} selected={mode} onSelect={setMode} />

        {mode === 'archive' && <Dropzone file={file} onPick={setFile} />}
        {mode === 'git' && (
          <div className="form-stack">
            <Field label="Repository URL">
              {(id) => (
                <input
                  id={id}
                  type="url"
                  placeholder="https://github.com/org/app.git"
                  value={git.url}
                  onChange={(event) => setGit({ ...git, url: event.target.value })}
                />
              )}
            </Field>
            <Field label="Branch or tag" hint="Optional: the repository's default branch.">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  placeholder="main"
                  value={git.ref}
                  onChange={(event) => setGit({ ...git, ref: event.target.value })}
                />
              )}
            </Field>
          </div>
        )}
        {mode === 'link' && (
          <div className="form-stack">
            <Field label="Name">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  maxLength={100}
                  placeholder="Documentation"
                  value={link.name}
                  onChange={(event) => setLink({ ...link, name: event.target.value })}
                />
              )}
            </Field>
            <Field label="Address" hint="The logo is fetched from this address. Otherwise, the launchpad shows the initial.">
              {(id) => (
                <input
                  id={id}
                  type="url"
                  placeholder="https://docs.example.com"
                  value={link.url}
                  onChange={(event) => setLink({ ...link, url: event.target.value })}
                />
              )}
            </Field>
            {groups.length > 0 && (
              <Field label="App group">
                {(id) => (
                  <select id={id} value={link.group} onChange={(event) => setLink({ ...link, group: event.target.value })}>
                    <option value="">None</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </div>
        )}

        <p className="dialog-note">{mode === 'link' ? LINK_NOTE : REVIEW_NOTE}</p>
        <div className="dialog-foot">
          <button className="btn primary" type="button" disabled={!ready || sending} onClick={submit}>
            {mode === 'link' ? 'Add link' : 'Run checks'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
