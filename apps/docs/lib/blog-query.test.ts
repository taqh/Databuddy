import type { Post, PostsListResponse } from "@usemarble/sdk/models";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	getPostModifiedAt,
	getPosts,
	getSinglePost,
	isPublished,
} from "./blog-query";

const publishedAt = new Date("2024-01-01T00:00:00.000Z");

function post(overrides: Partial<Post> = {}): Post {
	return {
		id: "post-1",
		slug: "post-1",
		title: "Published post",
		status: "published",
		featured: false,
		coverImage: null,
		description: "A post description",
		publishedAt,
		updatedAt: new Date("2024-02-01T00:00:00.000Z"),
		authors: [
			{
				id: "author-1",
				name: "Example Author",
				image: null,
				bio: null,
				role: null,
				slug: "example-author",
				socials: [],
			},
		],
		category: {
			id: "category-1",
			name: "Guides",
			slug: "guides",
			description: null,
		},
		tags: [],
		fields: {},
		content: "<p>Published content</p>",
		...overrides,
	};
}

function listResponse(
	posts: Post[],
	currentPage = 1,
	nextPage: number | null = null
): Response {
	const body: PostsListResponse = {
		posts,
		pagination: {
			limit: 100,
			currentPage,
			nextPage,
			previousPage: currentPage === 1 ? null : currentPage - 1,
			totalPages: nextPage ? nextPage : currentPage,
			totalItems: posts.length,
		},
	};
	return Response.json(body);
}

const originalApiKey = process.env.MARBLE_API_KEY;
const originalApiUrl = process.env.MARBLE_API_URL;
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of [
		["MARBLE_API_KEY", originalApiKey],
		["MARBLE_API_URL", originalApiUrl],
	] as const) {
		if (value === undefined) {
			Reflect.deleteProperty(process.env, name);
		} else {
			process.env[name] = value;
		}
	}
});

describe("Marble blog query", () => {
	test("does not make requests without a public read key", async () => {
		process.env.MARBLE_API_KEY = " ";
		const fetch = spyOn(globalThis, "fetch");
		expect(await getPosts()).toEqual([]);
		await expect(getSinglePost("missing-key")).rejects.toThrow(
			"NEXT_HTTP_ERROR_FALLBACK;404"
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("uses the API key and normalized custom server URL", async () => {
		process.env.MARBLE_API_KEY = "  test-token  ";
		process.env.MARBLE_API_URL = "https://marble.example/custom/v1///";
		const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(
			listResponse([post()])
		);
		expect(await getPosts()).toEqual([post()]);
		const firstCall = fetch.mock.calls[0];
		if (!firstCall) {
			throw new Error("Marble did not request posts");
		}
		const request = new Request(firstCall[0], firstCall[1]);
		expect(request.url).toContain("https://marble.example/custom/v1/posts?");
		const url = new URL(request.url);
		expect(url.searchParams.get("limit")).toBe("100");
		expect(url.searchParams.get("order")).toBe("desc");
		expect(url.searchParams.get("status")).toBe("published");
		expect(request.headers.get("Authorization")).toBe("test-token");
	});

	test("returns every page in descending publish order and filters unpublished content", async () => {
		process.env.MARBLE_API_KEY = "test-token";
		Reflect.deleteProperty(process.env, "MARBLE_API_URL");
		const older = post({
			id: "older",
			slug: "older",
			publishedAt: new Date("2024-01-01T00:00:00.000Z"),
		});
		const newer = post({
			id: "newer",
			slug: "newer",
			publishedAt: new Date("2024-03-01T00:00:00.000Z"),
		});
		const fetch = spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				listResponse([older, post({ status: "draft" })], 1, 2)
			)
			.mockResolvedValueOnce(
				listResponse([newer, post({ publishedAt: new Date("2999-01-01") })], 2)
			);
		expect((await getPosts()).map(({ slug }) => slug)).toEqual([
			"newer",
			"older",
		]);
		expect(fetch).toHaveBeenCalledTimes(2);
		const secondCall = fetch.mock.calls[1];
		if (!secondCall) {
			throw new Error("Marble did not request the second page");
		}
		expect(
			new URL(new Request(secondCall[0], secondCall[1]).url).searchParams.get(
				"page"
			)
		).toBe("2");
	});

	test("rejects the entire list if a later page fails", async () => {
		process.env.MARBLE_API_KEY = "test-token";
		const fetch = spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(listResponse([post()], 1, 2))
			.mockResolvedValueOnce(
				Response.json(
					{ error: "server_error", message: "Unavailable" },
					{ status: 503 }
				)
			);
		await expect(getPosts()).rejects.toMatchObject({ statusCode: 503 });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("RSS uses SDK dates and keeps its cache contract", async () => {
		process.env.MARBLE_API_KEY = "test-token";
		spyOn(globalThis, "fetch").mockResolvedValueOnce(
			listResponse([post({ title: "Published & tested" })])
		);
		const { GET } = await import("@/app/(home)/blog/rss.xml/route");
		const response = await GET();
		const xml = await response.text();
		expect(xml).toContain("<title>Published &amp; tested</title>");
		expect(xml).toContain("<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>");
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=3600, must-revalidate"
		);
	});

	test("maps missing and unpublished posts to 404 while outages propagate", async () => {
		process.env.MARBLE_API_KEY = "test-token";
		const fetch = spyOn(globalThis, "fetch");
		fetch.mockResolvedValueOnce(
			Response.json({ error: "not_found", message: "Missing" }, { status: 404 })
		);
		await expect(getSinglePost("missing")).rejects.toThrow(
			"NEXT_HTTP_ERROR_FALLBACK;404"
		);
		for (const [slug, value] of [
			["draft", post({ status: "draft" })],
			["future", post({ publishedAt: new Date("2999-01-01") })],
		] as const) {
			fetch.mockResolvedValueOnce(Response.json({ post: value }));
			await expect(getSinglePost(slug)).rejects.toThrow(
				"NEXT_HTTP_ERROR_FALLBACK;404"
			);
		}
		fetch.mockResolvedValueOnce(
			Response.json(
				{ error: "server_error", message: "Unavailable" },
				{ status: 503 }
			)
		);
		await expect(getSinglePost("unavailable")).rejects.toMatchObject({
			statusCode: 503,
		});
		fetch.mockResolvedValueOnce(Response.json({ post: post() }));
		expect(await getSinglePost("published")).toEqual(post());
	});

	test("rejects draft, future, and invalid publish dates", () => {
		expect(isPublished(post())).toBe(true);
		expect(isPublished(post({ status: "draft" }))).toBe(false);
		expect(isPublished(post({ publishedAt: new Date("2999-01-01") }))).toBe(
			false
		);
		expect(isPublished(post({ publishedAt: new Date("invalid") }))).toBe(false);
	});

	test("uses valid updates and falls back for invalid or future dates", () => {
		expect(getPostModifiedAt(post())).toBe("2024-02-01T00:00:00.000Z");
		for (const updatedAt of [
			new Date("invalid"),
			new Date("2023-01-01"),
			new Date("2999-01-01"),
		]) {
			expect(getPostModifiedAt(post({ updatedAt }))).toBe(
				publishedAt.toISOString()
			);
		}
	});
});
