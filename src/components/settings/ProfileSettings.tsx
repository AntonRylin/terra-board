import { useEffect, useRef, useState } from 'react';
import { Music, Play } from 'lucide-react';
import { chooseFiles, importFiles } from '../../bridge';
import { updatePreferences, usePreferences } from '../../settings/preferences';
import BoardIconImage, { type BoardIconImageHandle } from '../BoardIconImage';
import { playSong } from '../CollabLayer';
import { useCloudStatus } from '../ShareDialog';
import { Group, Notice, Row, Switch, useNotice } from './controls';

const clean = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');

// The name, picture and entrance song other people see on shared boards.
export function ProfileSettings() {
  const cloud = window.canvas?.cloud;
  const status = useCloudStatus();
  const preferences = usePreferences();
  const picture = useRef<BoardIconImageHandle>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('none');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNotice();
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
          description={
            profile?.song ? (
              <span className="cloud-status">
                <Music size={13} /> {profile.songName || 'Your song'}
              </span>
            ) : undefined
          }
        >
          {profile?.song && (
            <button
              type="button"
              className="st-button"
              onClick={() => void playSong(profile.song!).catch(() => {})}
            >
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
                const [file] = await chooseFiles('audio/*,.mp3,.m4a,.ogg,.wav');
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) throw Error('Choose a song up to 10 MB.');
                await ensureIdentity();
                const [asset] = await importFiles([file]);
                await cloud.setSong(asset.id, file.name);
              }, 'Song saved.')
            }
          >
            {profile?.song ? 'Change…' : 'Choose song…'}
          </button>
        </Row>
        <Row id="publishSong">
          <Switch
            label="Play my song when I join a board"
            checked={profile?.publishSong ?? true}
            disabled={busy || !status.identity}
            onChange={(on) => act(() => cloud.setPublishSong(on))}
          />
        </Row>
        <Row id="playSongs">
          <Switch
            label="Play other people's songs"
            checked={preferences.playJoinSongs}
            onChange={(playJoinSongs) => updatePreferences({ playJoinSongs })}
          />
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}
