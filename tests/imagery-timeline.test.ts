import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_IMAGERY,
  EMPTY_TIMELINE,
  loadTimeline,
  regionalImagery,
  timelineWithFrames,
  type FrameTimeline,
  type ImagerySource,
} from '../src/imagery';

const infrared = regionalImagery(13.08, 80.27)!;
/** Twelve 10-minute infrared frames ending at `newest`, as the provider advertises them. */
const tenMinuteFrames = (newest: string) =>
  Array.from({ length: 12 }, (_, i) =>
    new Date(Date.parse(newest) - (11 - i) * 600_000).toISOString().replace('.000Z', 'Z'),
  );
type Reply = {
  signal?: AbortSignal;
  force: boolean;
  resolve: (frames: string[]) => void;
  reject: (error: Error) => void;
};

/** WeatherMap's state, and one run of its metadata effect per layer change, timer or Refresh. */
function satelliteMap() {
  const replies: Reply[] = [];
  let timeline: FrameTimeline = EMPTY_TIMELINE;
  let status = { loading: false, error: '' };
  let cleanup = () => {};
  return {
    replies,
    run(source: ImagerySource, enabled = true, force = true) {
      cleanup();
      cleanup = loadTimeline(
        source,
        enabled,
        force,
        (change) => {
          timeline = change(timeline);
        },
        (loading, error) => {
          status = { loading, error };
        },
        (_source, signal, forced = false) =>
          new Promise((resolve, reject) =>
            replies.push({ signal, force: forced, resolve, reject }),
          ),
      );
    },
    /** The slider and the Play button. */
    select(index: number) {
      timeline = { ...timeline, index, playing: false };
    },
    play() {
      timeline = { ...timeline, playing: true };
    },
    /** What the panel shows: the frame on the map, the frame counter, the Play button, notices. */
    view(source: ImagerySource) {
      const { frames, index, playing } = timeline;
      return {
        shown: timeline.sourceId === source.id ? frames[index] : undefined,
        counter: frames.length ? `${index + 1} / ${frames.length}` : '—',
        playing,
        ...status,
      };
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a satellite refresh keeps the frames, the selected frame and playback while it runs and after it fails', async () => {
  const map = satelliteMap();
  const frames = tenMinuteFrames('2026-11-16T02:30:00Z');
  map.run(infrared, true, false);
  assert.equal(map.replies[0].force, false);
  map.replies[0].resolve(frames);
  await settle();
  assert.deepEqual(map.view(infrared), {
    shown: '2026-11-16T02:30:00Z',
    counter: '12 / 12',
    playing: false,
    loading: false,
    error: '',
  });

  // The viewer inspects an earlier frame and plays the animation; then the 5-minute timer fires.
  map.select(3);
  map.play();
  const selected = {
    shown: '2026-11-16T01:10:00Z',
    counter: '4 / 12',
    playing: true,
    loading: false,
    error: '',
  };
  map.run(infrared);
  assert.equal(map.replies[1].force, true);
  assert.deepEqual(map.view(infrared), { ...selected, loading: true });
  map.replies[1].resolve([...frames]);
  await settle();
  assert.deepEqual(map.view(infrared), selected);

  // A failed refresh is reported beside the frames already shown and removes nothing.
  map.run(infrared);
  map.replies[2].reject(new Error('NASA imagery metadata unavailable (503).'));
  await settle();
  assert.deepEqual(map.view(infrared), {
    ...selected,
    error: 'NASA imagery metadata unavailable (503).',
  });

  // The next attempt clears that message while it runs.
  map.run(infrared);
  assert.deepEqual(map.view(infrared), { ...selected, loading: true });
  map.replies[3].resolve([...frames]);
  await settle();
  assert.deepEqual(map.view(infrared), selected);
});

test('after a refresh the newest frame is followed and an earlier selection keeps its observation time', () => {
  const frames = tenMinuteFrames('2026-11-16T02:30:00Z');
  const newer = tenMinuteFrames('2026-11-16T02:40:00Z');
  const shown = (timeline: FrameTimeline) => timeline.frames[timeline.index];
  const on = (index: number, playing = false): FrameTimeline => ({
    sourceId: infrared.id,
    frames,
    index,
    playing,
  });
  // A viewer who never moved the slider is not left on the previous observation.
  assert.equal(shown(timelineWithFrames(on(11), infrared.id, newer)), '2026-11-16T02:40:00Z');
  // An earlier selection keeps its observation time and playback; its position moves.
  assert.deepEqual(timelineWithFrames(on(3, true), infrared.id, newer), {
    sourceId: infrared.id,
    frames: newer,
    index: 2,
    playing: true,
  });
  // A selected observation that is no longer advertised gives the next later one.
  const later = tenMinuteFrames('2026-11-16T03:00:00Z');
  assert.equal(shown(timelineWithFrames(on(1), infrared.id, later)), later[0]);
  const gap = frames.filter((frame) => frame !== frames[3]);
  assert.equal(shown(timelineWithFrames(on(3), infrared.id, gap)), frames[4]);
  // A single remaining frame cannot be animated.
  assert.deepEqual(timelineWithFrames(on(3, true), infrared.id, [frames[11]]), {
    sourceId: infrared.id,
    frames: [frames[11]],
    index: 0,
    playing: false,
  });
  // Daily composites are compared by date.
  const days = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'];
  const daily = { sourceId: DAILY_IMAGERY.id, frames: days.slice(0, 4), index: 1, playing: false };
  assert.equal(shown(timelineWithFrames(daily, DAILY_IMAGERY.id, days.slice(1))), '2026-11-13');
  assert.equal(
    shown(timelineWithFrames({ ...daily, index: 3 }, DAILY_IMAGERY.id, days.slice(1))),
    '2026-11-16',
  );
  // Frames of another layer open on their newest frame, paused.
  assert.deepEqual(timelineWithFrames(on(3, true), DAILY_IMAGERY.id, days), {
    sourceId: DAILY_IMAGERY.id,
    frames: days,
    index: 4,
    playing: false,
  });
});

test('another layer or a paused map starts empty, and a cancelled request changes nothing', async () => {
  const map = satelliteMap();
  map.run(infrared);
  map.replies[0].resolve(tenMinuteFrames('2026-11-16T02:30:00Z'));
  await settle();
  map.select(3);
  map.play();

  // Another layer shows nothing of the previous one and opens on its own newest frame.
  map.run(DAILY_IMAGERY);
  const waiting = { shown: undefined, counter: '—', playing: false, loading: true, error: '' };
  assert.deepEqual(map.view(DAILY_IMAGERY), waiting);
  map.replies[1].resolve(['2026-11-14', '2026-11-15', '2026-11-16']);
  await settle();
  assert.deepEqual(map.view(DAILY_IMAGERY), {
    shown: '2026-11-16',
    counter: '3 / 3',
    playing: false,
    loading: false,
    error: '',
  });

  // Switching back while a refresh runs cancels it; its late answer is ignored.
  map.run(DAILY_IMAGERY);
  map.run(infrared);
  assert.equal(map.replies[2].signal?.aborted, true);
  map.replies[2].resolve(['2026-11-16']);
  map.replies[3].reject(new Error('NASA imagery metadata timed out.'));
  await settle();
  assert.deepEqual(map.view(infrared), {
    ...waiting,
    loading: false,
    error: 'NASA imagery metadata timed out.',
  });

  // Data saver pauses the map: no request, nothing shown, nothing loading.
  map.run(infrared);
  map.replies[4].resolve(tenMinuteFrames('2026-11-16T02:30:00Z'));
  await settle();
  map.run(infrared, false);
  assert.equal(map.replies.length, 5);
  assert.deepEqual(map.view(infrared), { ...waiting, loading: false });
});
