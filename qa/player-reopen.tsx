/**
 * Entry of qa/player-reopen.sh. Plays clip A in the built-in player's VLCPlayer, pauses it and closes it as Back
 * does, then opens clip B in the same app session and writes PASS once B reports a duration, FAIL if it never does.
 */
import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import VLCPlayer, { type VLCPlayerRef } from '@lunarr/vlc-player';

const WAIT_MS = 20_000;
const report = (line: string) => {
	const file = new File(Paths.document, 'player-reopen.txt');
	if (!file.exists) file.create();
	file.write(line);
};
const clip = (name: string) => new File(Paths.bundle, 'player-reopen', name).uri;

function PlayerReopen() {
	const [step, setStep] = useState<'a' | 'closed' | 'b' | 'done'>('a');
	const player = useRef<VLCPlayerRef>(null);
	useEffect(() => {
		if (step === 'done') return undefined;
		// Closed for a moment, as between leaving one video and opening the next.
		if (step === 'closed') {
			const timer = setTimeout(() => setStep('b'), 500);
			return () => clearTimeout(timer);
		}
		const timer = setTimeout(() => {
			report(step === 'a' ? 'FAIL: clip A never played (setup)' : 'FAIL: clip B never reached a duration after clip A was paused and closed');
			setStep('done');
		}, WAIT_MS);
		return () => clearTimeout(timer);
	}, [step]);

	if (step === 'closed' || step === 'done') return <Text>{step}</Text>;
	return (
		<VLCPlayer
			key={step}
			ref={player}
			style={{ flex: 1 }}
			source={{ uri: clip(step === 'a' ? 'a.mkv' : 'b.mp4') }}
			continueAudioInBackground={false}
			showNowPlaying={false}
			progressUpdateInterval={500}
			onProgress={({ currentTime, duration }) => {
				if (duration <= 0) return;
				if (step === 'b') {
					report(`PASS: clip B reached ${duration} s`);
					setStep('done');
				} else if (currentTime >= 1) player.current?.pause();
			}}
			onPaused={() => step === 'a' && setStep('closed')}
		/>
	);
}

registerRootComponent(PlayerReopen);
