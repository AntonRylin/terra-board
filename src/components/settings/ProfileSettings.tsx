import { useEffect, useRef, useState } from 'react';
import { Link, Music, Play } from 'lucide-react';
import { chooseFiles, importFiles } from '../../bridge';
import { updatePreferences, usePreferences } from '../../settings/preferences';
import BoardIconImage, { type BoardIconImageHandle } from '../BoardIconImage';
import { playSong } from '../JoinToasts';
import { useCloudStatus } from '../ShareDialog';
import { useExtensionInstalled } from '../../extensions';
import { Group, Notice, Row, Switch, useNotice } from './controls';
import { SongClipEditor } from './SongClipEditor';

const clean = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

// The name, picture and entrance song other people see on shared boards.
export function ProfileSettings() {
  const cloud = window.canvas?.cloud;
  const status = useCloudStatus();
  const preferences = usePreferences();
  const songLinks = useExtensionInstalled('song-links');
  const picture = useRef<BoardIconImageHandle>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('none');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  // A song being trimmed to the part that plays, and the link it may come from.
  const [clip, setClip] = useState<{ bytes: ArrayBuffer; name: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const profile = status?.profile;
  useEffect(() => {
    if (status) setName((n) => n || status.name || '');
  }, [status?.name]);
  useEffect(() => {
    setIcon(profile?.avatar ? 'asset-' + profile.avatar : 'none');
  }, [profile?.avatar]);

  if (!cloud || !status?.configured)
    return (
      <Group>
        <Row title="Profile" description="Profiles are used for sharing in the desktop app." />
      </Group>
    );

  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await job();
      if (done) setNotice({ text: done });
    } catch (e) {
      setNotice({ text: clean(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const ensureIdentity = async () => {
    if (!name.trim()) throw Error('Enter your name first.');
    await cloud.identify(name.trim());
  };
  const fromLink = async () => {
    if (!link?.trim() || !window.canvas) return;
    setFetching(true);
    try {
      const song = await window.canvas.songFromLink(link.trim());
      setClip({ bytes: song.bytes.slice().buffer, name: song.name });
      setLink(null);
    } catch (e) {
      setNotice({ text: clean(e), error: true });
    } finally {
      setFetching(false);
    }
  };
  const songEditor = clip ? (
    <SongClipEditor
      bytes={clip.bytes}
      name={clip.name}
      busy={busy}
      onCancel={() => setClip(null)}
      onSave={(part, title) =>
        act(async () => {
          await ensureIdentity();
          const [asset] = await importFiles([
            new File([part], title + '.wav', { type: 'audio/wav' }),
          ]);
          await cloud.setSong(asset.id, title);
          setClip(null);
        }, 'Song saved.')
      }
    />
  ) : link !== null ? (
    <form
      className="song-link"
      onSubmit={(e) => {
        e.preventDefault();
        void fromLink();
      }}
    >
      <input
        className="st-name-input"
        aria-label="Song link"
        placeholder="https://www.youtube.com/watch?v=…"
        value={link}
        autoFocus
        disabled={fetching}
        onChange={(e) => setLink(e.target.value)}
      />
      <button type="button" className="st-button" disabled={fetching} onClick={() => setLink(null)}>
        Cancel
      </button>
      <button className="st-button primary" disabled={fetching || !link.trim()}>
        {fetching ? 'Getting the song…' : 'Get song'}
      </button>
    </form>
  ) : null;

  return (
    <>
      <Group>
        <Row id="profileName">
          <span className="cloud-join">
            <input
              className="st-name-input"
              aria-label="Your name"
              placeholder="Your name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
        </Row>
        <Row
          id="profilePicture"
          below={
            <div className="profile-picture">
              <BoardIconImage
                ref={picture}
                value={icon}
                color="blue"
                shape="circle"
                boardName={name || 'You'}
                showInitial
                onBusy={setBusy}
                onClear={() => setIcon('none')}
              />
            </div>
          }
        />
        <Row>
          <button
            type="button"
            className="st-button primary"
            disabled={busy || !name.trim()}
            onClick={() =>
              act(async () => {
                await ensureIdentity();
                const value = (await picture.current?.save()) ?? icon;
                const asset = value.startsWith('asset-') ? value.slice(6) : null;
                if (asset !== (profile?.avatar ?? null)) await cloud.setAvatar(asset);
                picture.current?.clear();
              }, 'Profile saved.')
            }
          >
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </Row>
      </Group>

      <Group title="Entrance song">
        <Row
          id="profileSong"
          below={songEditor}
          description={
            profile?.song ? (
              <span className="cloud-status">
                <Music size={13} /> {profile.songName || 'Your song'}
              </span>
            ) : undefined
          }
        >
          {profile?.song && (
            <button type="button" className="st-button" onClick={() => playSong(profile.song!)}>
              <Play size={13} /> Play
            </button>
          )}
          {profile?.song && (
            <button
              type="button"
              className="st-button"
              disabled={busy}
              onClick={() => act(() => cloud.setSong(null), 'Song removed.')}
            >
              Remove
            </button>
          )}
          <button
            type="button"
            className="st-button"
            disabled={busy || !name.trim()}
            onClick={() =>
              act(async () => {
                const [file] = await chooseFiles('audio/*,.mp3,.m4a,.ogg,.wav,.flac,.aac,.webm');
                if (!file) return;
                if (file.size > 60 * 1024 * 1024) throw Error('Choose a song up to 60 MB.');
                setLink(null);
                setClip({ bytes: await file.arrayBuffer(), name: file.name });
              })
            }
          >
            Choose file…
          </button>
          <button
            type="button"
            className="st-button"
            disabled={busy || fetching || !window.canvas?.songFromLink}
            onClick={() => {
              if (!songLinks)
                return setNotice({
                  text: 'Install Song links under Extensions to pick a song from a link.',
                });
              setClip(null);
              setLink('');
            }}
          >
            <Link size={13} /> From link…
          </button>
        </Row>
        <Row id="publishSong">
          <Switch
            label="Let others hear my song when I join"
            checked={profile?.publishSong ?? true}
            disabled={busy || !status.identity}
            onChange={(on) => act(() => cloud.setPublishSong(on))}
          />
        </Row>
        <Row id="hearOwnSong">
          <Switch
            label="Hear my song when I join a board"
            checked={preferences.hearOwnSong}
            onChange={(hearOwnSong) => updatePreferences({ hearOwnSong })}
          />
        </Row>
        <Row id="playSongs">
          <Switch
            label="Hear other people's songs"
            checked={preferences.playJoinSongs}
            onChange={(playJoinSongs) => updatePreferences({ playJoinSongs })}
          />
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}
