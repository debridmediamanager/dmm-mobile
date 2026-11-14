/** Where a PNG's visible pixels sit inside it, as fractions of its width and height. */
export interface Ink {
	/** The canvas's width over its height. */
	ratio: number;
	left: number;
	top: number;
	width: number;
	height: number;
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code as zlib's puff.c keeps it: how many codes of each length, and the symbols in code order. */
type Code = { count: Uint16Array; symbol: Uint16Array };
const code = (lengths: ArrayLike<number>): Code => {
	const count = new Uint16Array(16);
	const symbol = new Uint16Array(lengths.length);
	for (let n = 0; n < lengths.length; n++) count[lengths[n]]++;
	const offset = new Uint16Array(16);
	for (let length = 1; length < 15; length++) offset[length + 1] = offset[length] + count[length];
	for (let n = 0; n < lengths.length; n++) if (lengths[n]) symbol[offset[lengths[n]]++] = n;
	return { count, symbol };
};
const FIXED = (() => {
	const lengths = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
	return { literal: code(lengths), distance: code(new Uint8Array(30).fill(5)) };
})();

/** zlib's inflate (RFC 1950/1951) into an output of known size, after puff.c. Throws on a broken stream. */
export function inflate(input: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(size);
	let at = 2; // the zlib header
	let written = 0;
	let buffer = 0;
	let held = 0;
	const bits = (n: number) => {
		while (held < n) {
			if (at >= input.length) throw new Error('The compressed data ends early.');
			buffer |= input[at++] << held;
			held += 8;
		}
		const value = buffer & ((1 << n) - 1);
		buffer >>>= n;
		held -= n;
		return value;
	};
	const decode = ({ count, symbol }: Code) => {
		let value = 0;
		let first = 0;
		let index = 0;
		for (let length = 1; length < 16; length++) {
			value |= bits(1);
			if (value - count[length] < first) return symbol[index + value - first];
			index += count[length];
			first = (first + count[length]) << 1;
			value <<= 1;
		}
		throw new Error('A Huffman code is out of range.');
	};
	let last = 0;
	while (!last) {
		last = bits(1);
		const type = bits(2);
		if (type === 0) {
			buffer = 0;
			held = 0;
			const length = input[at] | (input[at + 1] << 8);
			at += 4;
			out.set(input.subarray(at, at + length), written);
			at += length;
			written += length;
			continue;
		}
		let literal = FIXED.literal;
		let distance = FIXED.distance;
		if (type === 2) {
			const literals = bits(5) + 257;
			const distances = bits(5) + 1;
			const codeLengths = new Uint8Array(19);
			const codes = bits(4) + 4;
			for (let n = 0; n < codes; n++) codeLengths[CODE_LENGTH_ORDER[n]] = bits(3);
			const lengthCode = code(codeLengths);
			const lengths = new Uint8Array(literals + distances);
			for (let n = 0; n < lengths.length; ) {
				const symbol = decode(lengthCode);
				if (symbol < 16) lengths[n++] = symbol;
				else {
					const repeat = symbol === 16 ? 3 + bits(2) : symbol === 17 ? 3 + bits(3) : 11 + bits(7);
					lengths.fill(symbol === 16 ? lengths[n - 1] : 0, n, n + repeat);
					n += repeat;
				}
			}
			literal = code(lengths.subarray(0, literals));
			distance = code(lengths.subarray(literals));
		} else if (type !== 1) throw new Error('Unknown block type.');
		for (;;) {
			let symbol = decode(literal);
			if (symbol < 256) out[written++] = symbol;
			else if (symbol === 256) break;
			else {
				symbol -= 257;
				const length = LENGTH_BASE[symbol] + bits(LENGTH_EXTRA[symbol]);
				const back = decode(distance);
				const from = written - DISTANCE_BASE[back] - bits(DISTANCE_EXTRA[back]);
				for (let n = 0; n < length; n++) out[written++] = out[from + n];
			}
		}
	}
	return out;
}

/**
 * The visible part of a PNG: logos come as 800x310 canvases with the artwork centred, often a third of the height
 * or width empty, and the player draws only the artwork so the lines below sit right under it. Read from 8-bit RGBA
 * or grey-and-alpha images, not interlaced; any other PNG counts as all visible. Null for no PNG or nothing visible.
 */
export function pngInk(bytes: Uint8Array, threshold = 16): Ink | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47) return null;
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (!width || !height) return null;
	const channels = bytes[25] === 6 ? 4 : bytes[25] === 4 ? 2 : 0;
	if (bytes[24] !== 8 || !channels || bytes[28] !== 0) return { ratio: width / height, left: 0, top: 0, width: 1, height: 1 };
	const parts: Uint8Array[] = [];
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = view.getUint32(at);
		if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const compressed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	parts.reduce((at, part) => (compressed.set(part, at), at + part.length), 0);
	const stride = width * channels;
	const raw = inflate(compressed, height * (stride + 1));
	let [left, top, right, bottom] = [width, height, -1, -1];
	const row = new Uint8Array(stride);
	const above = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const start = y * (stride + 1) + 1;
		const filter = raw[start - 1];
		// A filter reads the same channel of the pixel before and of the row above, so the alpha bytes decode on their own.
		for (let x = channels - 1; x < stride; x += channels) {
			const a = x >= channels ? row[x - channels] : 0;
			const b = above[x];
			const c = x >= channels ? above[x - channels] : 0;
			const value = raw[start + x];
			if (filter === 0) row[x] = value;
			else if (filter === 1) row[x] = value + a;
			else if (filter === 2) row[x] = value + b;
			else if (filter === 3) row[x] = value + ((a + b) >> 1);
			else {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				row[x] = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
			}
			if (row[x] <= threshold) continue;
			const pixel = (x - channels + 1) / channels;
			if (pixel < left) left = pixel;
			if (pixel > right) right = pixel;
			if (y < top) top = y;
			bottom = y;
		}
		above.set(row);
	}
	if (right < 0) return null;
	return { ratio: width / height, left: left / width, top: top / height, width: (right + 1 - left) / width, height: (bottom + 1 - top) / height };
}
