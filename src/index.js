import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { PDFArray, PDFDocument, PDFName, PDFString } from "pdf-lib";

// ============================================================================
// PDF.js Setup & Polyfills
// ============================================================================

/**
 * NOTE: pdfjs-dist/legacy/build/pdf.js attempts to `require("canvas")` in Node
 * to polyfill DOMMatrix/Path2D. We only need text extraction (not rendering),
 * so we can avoid pulling in `canvas` by providing minimal stubs.
 */
function setupPdfjsPolyfills() {
	const g = globalThis;
	if (!g.DOMMatrix) g.DOMMatrix = /** @type {any} */ (class DOMMatrix {});
	if (!g.Path2D) g.Path2D = /** @type {any} */ (class Path2D {});
	if (!g.CanvasRenderingContext2D)
		g.CanvasRenderingContext2D = /** @type {any} */ (
			class CanvasRenderingContext2D {}
		);
}

async function loadPdfjsModule() {
	setupPdfjsPolyfills();
	const pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.js");
	// pdfjs-dist legacy build is CJS/UMD; when imported from ESM, it's usually on `.default`.
	return /** @type {any} */ (pdfjsModule).default ?? pdfjsModule;
}

const pdfjs = await loadPdfjsModule();

// ============================================================================
// URL Utilities
// ============================================================================

/**
 * Get the base URL/path used when generating link annotations.
 *
 * Rationale:
 * - Many mobile PDF viewers do not resolve relative URI actions like `./file.pdf`.
 * - Absolute `https://...` URLs are the most compatible across viewers.
 *
 * Resolution order:
 * 1) `EVO_MANUAL_BASE_URL` env var (recommended; e.g. `https://colecrouter.github.io/evo-manual-fix/`)
 * 2) If running in GitHub Actions, infer `https://{owner}.github.io/{repo}/`
 * 3) Fallback to `./` for offline/local browsing
 */
function getBaseUrl() {
	const env = (process.env.EVO_MANUAL_BASE_URL ?? "").trim();
	if (env) return env.endsWith("/") ? env : `${env}/`;

	if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY) {
		const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
		if (owner && repo) return `https://${owner}.github.io/${repo}/`;
	}

	return "./";
}

/**
 * Join a base URL/path with a file name.
 * Handles absolute URLs (https://, file://, etc.) and relative paths correctly.
 * @param {string} base
 * @param {string} file
 */
function joinBase(base, file) {
	// Absolute URL bases (https://, file://, etc.)
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(base)) {
		return new URL(file, base).toString();
	}

	// Relative/path bases
	if (base === "./" || base === ".") return `./${file}`;
	if (base.endsWith("/")) return base + file;
	return `${base}/${file}`;
}

// ============================================================================
// Text Extraction from Index PDF
// ============================================================================

const LINK_PATTERN = /\d\d[A-Z]?-\d{1,3}/gm;
const INDEX_PDF_PATH = "./input/INDEX.pdf";

async function extractTextWithLocations() {
	// Keep a Buffer for pdf-lib, and pass a *copy* (Uint8Array) to pdf.js.
	// pdf.js may detach/transfer the underlying ArrayBuffer during loading.
	const indexPDFBytes = await readFile(INDEX_PDF_PATH);
	const indexPDFBytesForPdfjs = new Uint8Array(indexPDFBytes);

	// Silence noisy PDF.js warnings during headless text extraction.
	const indexPDFTask = pdfjs.getDocument({
		data: indexPDFBytesForPdfjs,
		verbosity: 0,
	});
	const pdfDoc = await indexPDFTask.promise;
	const pageCount = pdfDoc.numPages;

	/** @type Array<{text: string, x: number, y: number, pageIndex: number, w: number, h: number }> */
	const extractedText = [];

	// Extract each text "link" from the index PDF
	for (let i = 1; i <= pageCount; i++) {
		const page = await pdfDoc.getPage(i);
		const content = await page.getTextContent({ includeMarkedContent: false });

		for (const item of content.items) {
			/** @type import('pdfjs-dist/types/src/display/api').TextItem */ // pdf.js item
			if (LINK_PATTERN.test(item.str)) {
				extractedText.push({
					text: item.str,
					x: item.transform[4],
					y: item.transform[5],
					w: item.width,
					h: item.height,
					pageIndex: i - 1,
				});
			}
		}
	}

	return extractedText;
}

async function loadIndexPdf() {
	const indexPDFBytes = await readFile(INDEX_PDF_PATH);

	try {
		return await PDFDocument.load(indexPDFBytes);
	} catch (err) {
		const head = Buffer.from(indexPDFBytes).subarray(0, 8).toString("latin1");
		console.error(
			`[index] Failed to load ${INDEX_PDF_PATH} into pdf-lib (len=${indexPDFBytes.length}, head=${JSON.stringify(head)})`,
		);
		throw err;
	}
}

// ============================================================================
// Link Resolution
// ============================================================================

const INPUT_DIR = "./input/";
const OUTPUT_DIR = "./output/";

/**
 * Build a prefix-to-files mapping from PDF files in the input directory.
 * E.g., "GR00004200A-13A.pdf" -> prefix "13A"
 * Extracts the part after the last dash and before the .pdf extension
 */
async function buildFilePrefixMap() {
	const files = await readdir(INPUT_DIR);
	const filesByPrefix = new Map();

	for (const file of files) {
		if (file.endsWith(".pdf") && file !== "INDEX.pdf") {
			// Extract prefix from pattern like "GR00004200A-13A.pdf" -> "13A"
			const withoutExt = file.slice(0, -4); // Remove .pdf
			const lastDashIndex = withoutExt.lastIndexOf("-");

			if (lastDashIndex !== -1) {
				const prefix = withoutExt.slice(lastDashIndex + 1);
				if (!filesByPrefix.has(prefix)) {
					filesByPrefix.set(prefix, []);
				}
				filesByPrefix.get(prefix).push(file);
			}
		}
	}

	return filesByPrefix;
}

/**
 * Load and cache PDF page counts.
 * @param {string} file
 * @param {Map<string, number>} cache
 * @returns {Promise<number>}
 */
async function getPageCountCached(file, cache) {
	const cached = cache.get(file);
	if (cached !== undefined) {
		return cached;
	}

	const bytes = await readFile(INPUT_DIR + file);
	try {
		const pdf = await PDFDocument.load(bytes);
		const pageCount = pdf.getPageCount();
		cache.set(file, pageCount);
		return pageCount;
	} catch (err) {
		const head = Buffer.from(bytes).subarray(0, 8).toString("latin1");
		console.error(
			`[cache] Failed to load ${INPUT_DIR}${file} (len=${bytes.length}, head=${JSON.stringify(head)})`,
		);
		throw err;
	}
}

/**
 * Find which file and page offset a link should point to.
 * Returns { fileName, pageOffset }
 * @param {string} prefix
 * @param {number} pageIndex
 * @param {string[]} matchingFiles
 * @param {Map<string, number>} cache
 */
async function resolveLinkTarget(prefix, pageIndex, matchingFiles, cache) {
	let accumulatedPageCount = 0;

	for (const file of matchingFiles) {
		const filePageCount = await getPageCountCached(file, cache);
		accumulatedPageCount += filePageCount;

		// If our page index is within this file's range
		if (pageIndex < accumulatedPageCount) {
			return {
				fileName: file,
				pageOffset: accumulatedPageCount - filePageCount,
			};
		}
	}

	// If we reach here, the link is out of range
	throw new Error(
		`Cannot resolve link target for prefix "${prefix}" at page index ${pageIndex}`,
	);
}

/**
 * Create a PDF link annotation and register it with the document.
 * @param {PDFDocument} indexPDFDoc
 * @param {{text: string, x: number, y: number, pageIndex: number, w: number, h: number}} link
 * @param {string} uri
 */
function createLinkAnnotation(indexPDFDoc, link, uri) {
	const annotation = indexPDFDoc.context.register(
		indexPDFDoc.context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [link.x, link.y, link.x + link.w, link.y + link.h],
			Border: [0, 0, 2],
			C: [0, 0, 1],
			A: {
				Type: "Action",
				S: "URI",
				URI: PDFString.of(uri),
			},
		}),
	);
	return annotation;
}

// ============================================================================
// GoToR Link Conversion
// ============================================================================

/**
 * Copy all files (excluding directories) from input to output directory.
 * @param {string} inputDir
 * @param {string} outputDir
 */
async function copyInputFilesToOutput(inputDir, outputDir) {
	const files = await readdir(inputDir);

	for (const file of files) {
		const stats = await stat(inputDir + file);
		if (stats.isFile()) {
			await copyFile(inputDir + file, outputDir + file);
		}
	}
}

/**
 * Save the modified PDF document to the output directory.
 * @param {PDFDocument} indexPDFDoc
 * @param {string} outputPath
 */
async function savePdfDocument(indexPDFDoc, outputPath) {
	const bytes = await indexPDFDoc.save();
	await writeFile(outputPath, bytes);
}

// ============================================================================
// GoToR Link Conversion
// ============================================================================

// ============================================================================
// GoToR Link Conversion
// ============================================================================

/**
 * Extract text content from a specific region of a PDF page.
 * @param {any} pdfjsPage - PDF.js page object
 * @param {number[]} rect - [x1, y1, x2, y2] rectangle
 * @returns {Promise<string>}
 */
async function extractTextFromRegion(pdfjsPage, rect) {
	const [x1, y1, x2, y2] = rect;
	const content = await pdfjsPage.getTextContent({
		includeMarkedContent: false,
	});

	let text = "";
	for (const item of content.items) {
		const itemX = item.transform[4];
		const itemY = item.transform[5];

		// Check if item is within the rectangle (with some tolerance)
		if (
			itemX >= x1 - 5 &&
			itemX <= x2 + 5 &&
			itemY >= y1 - 5 &&
			itemY <= y2 + 5
		) {
			text += item.str;
		}
	}

	return text.trim();
}

/**
 * Convert GoToR links in a PDF to URI links with absolute URLs.
 * @param {string} filePath
 * @param {string} fileName
 * @param {string} baseUrl
 * @param {Map<string, PDFDocument>} pdfCache
 * @param {Map<string, number>} pageCountCache
 * @param {Map<string, string[]>} filesByPrefix
 * @returns {Promise<{converted: number, failed: number}>}
 */
async function convertGoToRLinks(
	filePath,
	fileName,
	baseUrl,
	pdfCache,
	pageCountCache,
	filesByPrefix,
) {
	const bytes = await readFile(filePath);
	const pdf = await PDFDocument.load(bytes);
	const pages = pdf.getPages();

	// Also load with pdf.js for text extraction
	const pdfjsTask = pdfjs.getDocument({
		data: new Uint8Array(bytes),
		verbosity: 0,
	});
	const pdfjsDoc = await pdfjsTask.promise;

	let converted = 0;
	let failed = 0;
	let modified = false;

	for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
		const page = pages[pageIdx];
		const pdfjsPage = await pdfjsDoc.getPage(pageIdx + 1);

		// Try to get annotations, but don't throw if they don't exist
		let annots;
		try {
			annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
		} catch {
			// Page has no annotations
			continue;
		}
		if (!annots) continue;

		for (let i = 0; i < annots.size(); i++) {
			const annotRef = annots.get(i);
			const annot = pdf.context.lookup(annotRef);
			if (!annot) continue;

			const subtype = annot.get(PDFName.of("Subtype"));
			if (subtype?.toString() !== "/Link") continue;

			const action = annot.get(PDFName.of("A"));
			if (!action) continue;

			const actionDict = pdf.context.lookup(action);
			if (!actionDict) continue;

			const actionType = actionDict.get(PDFName.of("S"));
			if (actionType?.toString() !== "/GoToR") continue;

			try {
				// Get rectangle to extract text
				const rect = annot.get(PDFName.of("Rect"));
				if (!rect) {
					failed++;
					continue;
				}

				const rectArray = [
					rect.get(0),
					rect.get(1),
					rect.get(2),
					rect.get(3),
				].map((n) =>
					typeof n?.value === "number"
						? n.value
						: parseFloat(n?.toString() || "0"),
				);

				// Extract text from link region
				const linkText = await extractTextFromRegion(pdfjsPage, rectArray);

				// Try to parse as section-page reference
				// Handle formats like "35C-2", "P.35C-2", "See 35C-2", or just "42A"
				let match = linkText.match(/\b(\d\d[A-Z]?)-(\d{1,3})\b/);
				let prefix, pageNum;

				if (match) {
					// Found format like "35C-2"
					[, prefix, pageNum] = match;
				} else {
					// Try format without page number, like "42A"
					match = linkText.match(/\b(\d\d[A-Z]?)\b/);
					if (match) {
						prefix = match[1];
						pageNum = "1"; // Default to page 1
					} else {
						failed++;
						continue;
					}
				}

				const matchingFiles = filesByPrefix.get(prefix) || [];

				if (matchingFiles.length === 0) {
					console.warn(
						`  No files found for prefix "${prefix}" in ${fileName}`,
					);
					failed++;
					continue;
				}

				// Resolve to target file and page
				const { fileName: targetFile, pageOffset } = await resolveLinkTarget(
					prefix,
					Number(pageNum) - 1,
					matchingFiles,
					pageCountCache,
				);

				const uri = `${joinBase(baseUrl, targetFile)}#page=${Number(pageNum) - pageOffset}`;

				// Replace action with URI action
				actionDict.set(PDFName.of("S"), PDFName.of("URI"));
				actionDict.set(PDFName.of("URI"), PDFString.of(uri));
				actionDict.delete(PDFName.of("F"));
				actionDict.delete(PDFName.of("D"));
				actionDict.delete(PDFName.of("NewWindow"));

				converted++;
				modified = true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				failed++;
			}
		}
	}

	// Save modified PDF
	if (modified) {
		const outputPath = filePath.replace(INPUT_DIR, OUTPUT_DIR);
		await savePdfDocument(pdf, outputPath);
	}

	return { converted, failed };
}

// ============================================================================
// Main Processing
// ============================================================================

async function main() {
	// Setup
	const baseUrl = getBaseUrl();
	const filesByPrefix = await buildFilePrefixMap();
	const indexPDFDoc = await loadIndexPdf();
	const indexPDFPages = indexPDFDoc.getPages();
	const extractedLinks = await extractTextWithLocations();

	// Initialize annotations array for each page
	const annotationsByPage = Array(indexPDFPages.length);
	const pageAnnotationCounts = new Array(indexPDFPages.length).fill(0);
	const pageCache = new Map();
	let successfulLinks = 0;
	let failedLinks = 0;

	// Process each extracted link
	for (const link of extractedLinks) {
		const page = indexPDFPages[link.pageIndex];

		// Initialize annotations array for this page if needed
		if (annotationsByPage[link.pageIndex] === undefined) {
			annotationsByPage[link.pageIndex] = page.node.lookup(
				PDFName.of("Annots"),
				PDFArray,
			);
			pageAnnotationCounts[link.pageIndex]++;
		}

		// Parse the link reference (e.g., "08A-42" -> prefix: "08A", pageNum: "42")
		const [prefix, pageNum] = link.text.split("-");
		const matchingFiles = filesByPrefix.get(prefix) || [];

		if (matchingFiles.length === 0) {
			console.warn(`No files found for prefix "${prefix}"`);
			failedLinks++;
			continue;
		}

		try {
			const { fileName, pageOffset } = await resolveLinkTarget(
				prefix,
				Number(pageNum) - 1, // Convert to 0-based page index
				matchingFiles,
				pageCache,
			);

			const uri = `${joinBase(baseUrl, fileName)}#page=${Number(pageNum) - pageOffset}`;
			const annotation = createLinkAnnotation(indexPDFDoc, link, uri);

			annotationsByPage[link.pageIndex].push(annotation);
			successfulLinks++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Failed to create link for text "${link.text}":`, message);
			failedLinks++;
		}
	}

	// Save results
	await mkdir(OUTPUT_DIR).catch(() => {});
	await copyInputFilesToOutput(INPUT_DIR, OUTPUT_DIR);
	await savePdfDocument(indexPDFDoc, `${OUTPUT_DIR}INDEX.pdf`);

	console.log(
		`[INDEX] Processed ${successfulLinks} successful links (${failedLinks} failed) across ${pageAnnotationCounts.filter((c) => c > 0).length} pages`,
	);

	// Process all other PDF files to convert GoToR links
	console.log("\n[OTHER PDFs] Converting GoToR links to URI links...");
	const files = await readdir(INPUT_DIR);
	const pdfLinkCache = new Map();
	let totalConverted = 0;
	let totalFailed = 0;
	let filesProcessed = 0;

	for (const file of files) {
		if (file.endsWith(".pdf") && file !== "INDEX.pdf") {
			const { converted, failed } = await convertGoToRLinks(
				`${INPUT_DIR}${file}`,
				file,
				baseUrl,
				pdfLinkCache,
				pageCache,
				filesByPrefix,
			);

			if (converted > 0 || failed > 0) {
				console.log(`  ${file}: ${converted} converted, ${failed} failed`);
				filesProcessed++;
			}

			totalConverted += converted;
			totalFailed += failed;
		}
	}

	console.log(
		`\n✓ Converted ${totalConverted} GoToR links (${totalFailed} failed) across ${filesProcessed} files`,
	);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
