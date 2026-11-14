import { readFileSync } from 'node:fs';
import { pngInk } from './png';

const fixture = (name: string) => new Uint8Array(readFileSync(`${__dirname}/test/fixtures/${name}`));
/** PIL's getbbox of the alpha channel above 16, in pixels: left, top, right, bottom (exclusive). */
const box = (ink: ReturnType<typeof pngInk>, width: number, height: number) =>
	ink && [Math.round(ink.left * width), Math.round(ink.top * height), Math.round((ink.left + ink.width) * width), Math.round((ink.top + ink.height) * height)];

describe('pngInk', () => {
	it('finds a wide logo inside the empty top and bottom of its 800x310 canvas (Sintel, metahub)', () => {
		const ink = pngInk(fixture('metahub-logo-sintel-tt1727587.png'));
		expect(box(ink, 800, 310)).toEqual([10, 92, 794, 222]);
		expect(ink?.ratio).toBeCloseTo(800 / 310);
	});

	it('finds a tall logo inside the empty sides of its canvas (Big Buck Bunny, metahub)', () => {
		expect(box(pngInk(fixture('metahub-logo-big-buck-bunny-tt1254207.png')), 800, 310)).toEqual([76, 9, 727, 303]);
	});

	it('reads stored and fixed-Huffman blocks, grey and alpha, and ignores faint pixels', () => {
		expect(box(pngInk(fixture('png-stored-rgba.png')), 40, 20)).toEqual([5, 3, 31, 17]);
		expect(box(pngInk(fixture('png-fixed-grey-alpha.png')), 30, 12)).toEqual([2, 4, 20, 9]);
	});

	it('gives up on what is not a PNG with alpha', () => {
		expect(pngInk(new TextEncoder().encode('<html>not found</html>'))).toBeNull();
	});
});
