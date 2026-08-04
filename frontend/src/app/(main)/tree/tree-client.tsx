'use client';

import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { ContributeDialog } from '@/components/contribute-dialog';
import { Search, ZoomIn, ZoomOut, Maximize2, TreePine, Eye, Users, GitBranch, User, ArrowDownToLine, ArrowUpFromLine, Crosshair, X, ChevronDown, ChevronRight, BarChart3, Package, Link, ChevronsDownUp, ChevronsUpDown, Copy, Pencil, Save, RotateCcw, Trash2, ArrowUp, ArrowDown, GripVertical, MessageSquarePlus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

import {
    fetchTreeData,
    updateFamilyChildren as supaUpdateFamilyChildren,
    moveChildToFamily as supaMoveChild,
    removeChildFromFamily as supaRemoveChild,
    updatePersonLiving as supaUpdatePersonLiving,
    updatePerson as supaUpdatePerson,
    addPerson as supaAddPerson,
    deletePerson as supaDeletePerson, 
    addFamily as supaAddFamily,
    changePersonHandle as supaChangePersonHandle,
    changeFamilyHandle as supaChangeFamilyHandle,
    updateFamilyParents as supaUpdateFamilyParents,
    deleteFamily as supaDeleteFamily
} from '@/lib/supabase-data';
import {
    computeLayout, filterAncestors, filterDescendants,
    CARD_W, CARD_H,
    type TreeNode, type TreeFamily, type LayoutResult, type PositionedNode, type PositionedCouple, type Connection,
} from '@/lib/tree-layout';
import { getMockTreeData } from '@/lib/mock-data';

type ViewMode = 'full' | 'ancestor' | 'descendant';
type ZoomLevel = 'full' | 'compact' | 'mini';

function getZoomLevel(scale: number): ZoomLevel {
    if (scale > 0.6) return 'full';
    if (scale > 0.3) return 'compact';
    return 'mini';
}

// === Branch Summary (F4) ===
interface BranchSummary {
    parentHandle: string;
    totalDescendants: number;
    generationRange: [number, number];
    livingCount: number;
    deceasedCount: number;
    patrilinealCount: number;
}

function computeBranchSummary(
    handle: string,
    people: TreeNode[],
    families: TreeFamily[],
): BranchSummary {
    const personMap = new Map(people.map(p => [p.handle, p]));
    const familyMap = new Map(families.map(f => [f.handle, f]));
    const visited = new Set<string>();
    let livingCount = 0, deceasedCount = 0, patrilinealCount = 0;
    let minGen = Infinity, maxGen = -Infinity;

    function walk(h: string, gen: number) {
        if (visited.has(h)) return;
        visited.add(h);
        const person = personMap.get(h);
        if (!person) return;
        if (gen < minGen) minGen = gen;
        if (gen > maxGen) maxGen = gen;
        if (person.isLiving) livingCount++; else deceasedCount++;
        if (person.isPatrilineal) patrilinealCount++;
        for (const fId of person.families) {
            const fam = familyMap.get(fId);
            if (!fam) continue;
            for (const ch of fam.children) walk(ch, gen + 1);
        }
    }

    // Walk from this person's children (not including the person itself)
    const person = personMap.get(handle);
    if (person) {
        for (const fId of person.families) {
            const fam = familyMap.get(fId);
            if (!fam) continue;
            // Also count spouse
            if (fam.motherHandle && fam.motherHandle !== handle && !visited.has(fam.motherHandle)) {
                const spouse = personMap.get(fam.motherHandle);
                if (spouse) { visited.add(fam.motherHandle); if (spouse.isLiving) livingCount++; else deceasedCount++; }
            }
            if (fam.fatherHandle && fam.fatherHandle !== handle && !visited.has(fam.fatherHandle)) {
                const spouse = personMap.get(fam.fatherHandle);
                if (spouse) { visited.add(fam.fatherHandle); if (spouse.isLiving) livingCount++; else deceasedCount++; }
            }
            for (const ch of fam.children) walk(ch, 1);
        }
    }

    return {
        parentHandle: handle,
        totalDescendants: visited.size,
        generationRange: [minGen === Infinity ? 0 : minGen, maxGen === -Infinity ? 0 : maxGen],
        livingCount, deceasedCount, patrilinealCount,
    };
}

// === Tree Stats (F3) ===
interface TreeStats {
    total: number;
    totalFamilies: number;
    totalGenerations: number;
    perGeneration: { gen: number; count: number }[];
    livingCount: number;
    deceasedCount: number;
    patrilinealCount: number;
    nonPatrilinealCount: number;
}

function computeTreeStats(nodes: PositionedNode[], families: TreeFamily[]): TreeStats {
    const genMap = new Map<number, number>();
    let living = 0, deceased = 0, patri = 0, nonPatri = 0;
    for (const n of nodes) {
        const gen = n.generation + 1;
        genMap.set(gen, (genMap.get(gen) ?? 0) + 1);
        if (n.node.isLiving) living++; else deceased++;
        if (n.node.isPatrilineal) patri++; else nonPatri++;
    }
    const perGeneration = Array.from(genMap.entries())
        .map(([gen, count]) => ({ gen, count }))
        .sort((a, b) => a.gen - b.gen);
    return {
        total: nodes.length,
        totalFamilies: families.length,
        totalGenerations: perGeneration.length,
        perGeneration,
        livingCount: living,
        deceasedCount: deceased,
        patrilinealCount: patri,
        nonPatrilinealCount: nonPatri,
    };
}

// Default depth at which branches auto-collapse in panoramic view (0-indexed: gen 3 = Đời 4)
const AUTO_COLLAPSE_GEN = 8;

// Compute generations via BFS from root persons (persons not in any family as children)
function computePersonGenerations(people: TreeNode[], families: TreeFamily[]): Map<string, number> {
    const childOf = new Set<string>();
    for (const f of families) for (const ch of f.children) childOf.add(ch);
    const roots = people.filter(p => p.isPatrilineal && !childOf.has(p.handle));
    const gens = new Map<string, number>();
    const familyMap = new Map(families.map(f => [f.handle, f]));
    const queue: { handle: string; gen: number }[] = roots.map(r => ({ handle: r.handle, gen: 0 }));
    while (queue.length > 0) {
        const { handle, gen } = queue.shift()!;
        if (gens.has(handle)) continue;
        gens.set(handle, gen);
        const person = people.find(p => p.handle === handle);
        if (!person) continue;
        for (const fId of person.families) {
            const fam = familyMap.get(fId);
            if (!fam) continue;
            // Spouse at same gen
            if (fam.fatherHandle && !gens.has(fam.fatherHandle)) gens.set(fam.fatherHandle, gen);
            if (fam.motherHandle && !gens.has(fam.motherHandle)) gens.set(fam.motherHandle, gen);
            for (const ch of fam.children) {
                if (!gens.has(ch)) queue.push({ handle: ch, gen: gen + 1 });
            }
        }
    }
    return gens;
}

export default function TreeViewPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const containerRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);

    const [treeData, setTreeData] = useState<{ people: TreeNode[]; families: TreeFamily[] } | null>(null);
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useState<ViewMode>('full');
    const [focusPerson, setFocusPerson] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);
    const [highlightHandles, setHighlightHandles] = useState<Set<string>>(new Set());
    const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ handle: string; x: number; y: number } | null>(null);
    const [contributePerson, setContributePerson] = useState<{ handle: string; name: string } | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);

    // F4: Collapsible branches
    const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(new Set());
    // F3: Stats panel user-hidden
    const [statsHidden, setStatsHidden] = useState(false);

    // Editor mode state
    const [editorMode, setEditorMode] = useState(false);
    const [selectedCard, setSelectedCard] = useState<string | null>(null);
    const [selectedFamilyCard, setSelectedFamilyCard] = useState<string | null>(null);
    const [draftPerson, setDraftPerson] = useState<TreeNode | null>(null);
    const [draftFamily, setDraftFamily] = useState<TreeFamily | null>(null);
    const { isAdmin } = useAuth();

    // URL query param initialization + auto-collapse on initial load
    const urlInitialized = useRef(false);
    useEffect(() => {
        if (urlInitialized.current || !treeData) return;
        urlInitialized.current = true;
        const viewParam = searchParams.get('view') as ViewMode | null;
        const personParam = searchParams.get('person');
        if (viewParam && ['full', 'ancestor', 'descendant'].includes(viewParam)) {
            setViewMode(viewParam);
        }
        if (personParam && treeData.people.some(p => p.handle === personParam)) {
            setFocusPerson(personParam);
        }
        // Auto-collapse on initial load
        if (!viewParam || viewParam === 'full') {
            // Panoramic: collapse by absolute generation
            const gens = computePersonGenerations(treeData.people, treeData.families);
            const toCollapse = new Set<string>();
            for (const f of treeData.families) {
                if (f.children.length === 0) continue;
                const parentHandle = f.fatherHandle || f.motherHandle;
                if (!parentHandle) continue;
                const gen = gens.get(parentHandle);
                if (gen !== undefined && gen >= AUTO_COLLAPSE_GEN) {
                    toCollapse.add(parentHandle);
                }
            }
            setCollapsedBranches(toCollapse);
        } else if (viewParam === 'descendant' && personParam) {
            // Descendant: collapse by relative depth from focus person
            const personMap = new Map(treeData.people.map(p => [p.handle, p]));
            const toCollapse = new Set<string>();
            const depthMap = new Map<string, number>();
            const queue: string[] = [personParam];
            depthMap.set(personParam, 0);
            while (queue.length > 0) {
                const h = queue.shift()!;
                const depth = depthMap.get(h)!;
                const p = personMap.get(h);
                if (!p) continue;
                for (const fId of p.families) {
                    const fam = treeData.families.find(f => f.handle === fId);
                    if (!fam || fam.children.length === 0) continue;
                    if (depth >= AUTO_COLLAPSE_GEN) {
                        toCollapse.add(h);
                    } else {
                        for (const ch of fam.children) {
                            if (!depthMap.has(ch)) {
                                depthMap.set(ch, depth + 1);
                                queue.push(ch);
                            }
                        }
                    }
                }
            }
            setCollapsedBranches(toCollapse);
        }
    }, [searchParams, treeData]);

    // Sync URL when view/focus changes
    useEffect(() => {
        if (!urlInitialized.current) return;
        const params = new URLSearchParams();
        if (viewMode !== 'full') params.set('view', viewMode);
        if (focusPerson && viewMode !== 'full') params.set('person', focusPerson);
        const qs = params.toString();
        router.replace(`/tree${qs ? '?' + qs : ''}`, { scroll: false });
    }, [viewMode, focusPerson, router]);

    // Transform state
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
    const [isDragging, setIsDragging] = useState(false);
    const dragRef = useRef({ startX: 0, startY: 0, startTx: 0, startTy: 0 });
    const pinchRef = useRef({ initialDist: 0, initialScale: 1 });

    // Fetch data
    useEffect(() => {
        const fetchTree = async () => {
            try {
                const token = localStorage.getItem('accessToken');
                const apiUrl = process.env.NEXT_PUBLIC_API_URL;
                if (token && apiUrl) {
                    const res = await fetch(`${apiUrl}/genealogy/tree`, {
                        headers: { Authorization: `Bearer ${token}` },
                        signal: AbortSignal.timeout(3000),
                    });
                    if (res.ok) {
                        const json = await res.json();
                        setTreeData(json.data);
                        setLoading(false);
                        return;
                    }
                }
            } catch { /* fallback */ }
            // Load from Supabase
            try {
                const data = await fetchTreeData();
                if (data.people.length > 0) {
                    setTreeData(data);
                    setLoading(false);
                    return;
                }
            } catch { /* fallback to mock */ }
            // Fallback: use bundled mock data (demo mode)
            setTreeData(getMockTreeData());
            setLoading(false);
        };
        fetchTree();
    }, []);

    // Filtered data for view mode
    const displayData = useMemo(() => {
        if (!treeData) return null;
        if (viewMode === 'full' || !focusPerson) return treeData;
        if (viewMode === 'ancestor') return filterAncestors(focusPerson, treeData.people, treeData.families);
        if (viewMode === 'descendant') return filterDescendants(focusPerson, treeData.people, treeData.families);
        return treeData;
    }, [treeData, viewMode, focusPerson]);

    // F1: Zoom level
    const zoomLevel = useMemo<ZoomLevel>(() => getZoomLevel(transform.scale), [transform.scale]);

    // F4: Get all descendants of collapsed branches
    const getDescendantHandles = useCallback((handle: string): Set<string> => {
        if (!treeData) return new Set();
        const personMap = new Map(treeData.people.map(p => [p.handle, p]));
        const familyMap = new Map(treeData.families.map(f => [f.handle, f]));
        const result = new Set<string>();
        function walk(h: string) {
            const person = personMap.get(h);
            if (!person) return;
            for (const fId of person.families) {
                const fam = familyMap.get(fId);
                if (!fam) continue;
                // Include spouse
                if (fam.motherHandle && fam.motherHandle !== h) result.add(fam.motherHandle);
                if (fam.fatherHandle && fam.fatherHandle !== h) result.add(fam.fatherHandle);
                for (const ch of fam.children) {
                    result.add(ch);
                    walk(ch);
                }
            }
        }
        walk(handle);
        return result;
    }, [treeData]);

    // F4: Compute all hidden handles from collapsed branches
    const hiddenHandles = useMemo(() => {
        if (!treeData) return new Set<string>();
        const hidden = new Set<string>();
        for (const h of collapsedBranches) {
            const descendants = getDescendantHandles(h);
            for (const d of descendants) hidden.add(d);
        }
        // Cascade: hide people whose ALL parent families have hidden fathers
        // This catches nodes that leaked through (e.g., gen 13 whose gen 12 parents are hidden)
        const familyMap = new Map(treeData.families.map(f => [f.handle, f]));
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of treeData.people) {
                if (hidden.has(p.handle)) continue;
                if (p.parentFamilies.length === 0) continue;
                // Check if ALL parent families have their father/mother hidden
                const allParentsHidden = p.parentFamilies.every(pfId => {
                    const pf = familyMap.get(pfId);
                    if (!pf) return true; // orphan family = treat as hidden
                    const fatherHidden = pf.fatherHandle ? hidden.has(pf.fatherHandle) : true;
                    const motherHidden = pf.motherHandle ? hidden.has(pf.motherHandle) : true;
                    return fatherHidden && motherHidden;
                });
                if (allParentsHidden) {
                    hidden.add(p.handle);
                    changed = true;
                }
            }
        }
        return hidden;
    }, [collapsedBranches, getDescendantHandles, treeData]);

    // F4: Branch summaries for collapsed branches
    const branchSummaries = useMemo(() => {
        if (!treeData) return new Map<string, BranchSummary>();
        const map = new Map<string, BranchSummary>();
        for (const h of collapsedBranches) {
            map.set(h, computeBranchSummary(h, treeData.people, treeData.families));
        }
        return map;
    }, [collapsedBranches, treeData]);

    // F4: Toggle collapse — reveals one level at a time when expanding
    const toggleCollapse = useCallback((handle: string) => {
        if (!treeData) return;
        setCollapsedBranches(prev => {
            const next = new Set(prev);
            if (next.has(handle)) {
                // Expanding: remove this person's collapse, but auto-collapse their
                // direct children who have descendants (progressive reveal)
                next.delete(handle);
                const person = treeData.people.find(p => p.handle === handle);
                if (person) {
                    for (const fId of person.families) {
                        const fam = treeData.families.find(f => f.handle === fId);
                        if (!fam) continue;
                        for (const ch of fam.children) {
                            // Check if child has their own children
                            const childPerson = treeData.people.find(p => p.handle === ch);
                            if (childPerson) {
                                const childHasChildren = childPerson.families.some(cfId => {
                                    const cf = treeData.families.find(f => f.handle === cfId);
                                    return cf && cf.children.length > 0;
                                });
                                if (childHasChildren) {
                                    next.add(ch);
                                }
                            }
                        }
                    }
                }
            } else {
                next.add(handle);
            }
            return next;
        });
    }, [treeData]);

    // Expand All / Collapse All
    const expandAll = useCallback(() => {
        setCollapsedBranches(new Set());
    }, []);

    const collapseAll = useCallback(() => {
        if (!treeData) return;
        const allParents = new Set<string>();
        for (const f of treeData.families) {
            if (f.children.length > 0) {
                if (f.fatherHandle) allParents.add(f.fatherHandle);
                if (f.motherHandle) allParents.add(f.motherHandle);
            }
        }
        setCollapsedBranches(allParents);
    }, [treeData]);

    // Auto-collapse for Toàn cảnh view
    const autoCollapseForPanoramic = useCallback(() => {
        if (!treeData) return;
        const gens = computePersonGenerations(treeData.people, treeData.families);
        const toCollapse = new Set<string>();
        for (const f of treeData.families) {
            if (f.children.length === 0) continue;
            const parentHandle = f.fatherHandle || f.motherHandle;
            if (!parentHandle) continue;
            const gen = gens.get(parentHandle);
            if (gen !== undefined && gen >= AUTO_COLLAPSE_GEN) {
                toCollapse.add(parentHandle);
            }
        }
        setCollapsedBranches(toCollapse);
    }, [treeData]);

    // Auto-collapse for Hậu duệ view: collapse branches beyond AUTO_COLLAPSE_GEN relative depth from focus
    const autoCollapseForDescendant = useCallback((person: string) => {
        if (!treeData) return;
        const personMap = new Map(treeData.people.map(p => [p.handle, p]));
        const toCollapse = new Set<string>();
        // BFS from person to compute relative depth
        const depthMap = new Map<string, number>();
        const queue: string[] = [person];
        depthMap.set(person, 0);
        while (queue.length > 0) {
            const h = queue.shift()!;
            const depth = depthMap.get(h)!;
            const p = personMap.get(h);
            if (!p) continue;
            for (const fId of p.families) {
                const fam = treeData.families.find(f => f.handle === fId);
                if (!fam || fam.children.length === 0) continue;
                if (depth >= AUTO_COLLAPSE_GEN) {
                    toCollapse.add(h);
                } else {
                    for (const ch of fam.children) {
                        if (!depthMap.has(ch)) {
                            depthMap.set(ch, depth + 1);
                            queue.push(ch);
                        }
                    }
                }
            }
        }
        setCollapsedBranches(toCollapse);
    }, [treeData]);

    // Compute layout — filter out hidden nodes from collapsed branches
    const layout = useMemo<LayoutResult | null>(() => {
        if (!displayData) return null;
        const d = 'filteredPeople' in displayData
            ? { people: (displayData as any).filteredPeople, families: (displayData as any).filteredFamilies }
            : displayData;
        // F4: Filter out hidden handles
        const visiblePeople = d.people.filter((p: TreeNode) => !hiddenHandles.has(p.handle));
        const visibleFamilies = d.families.filter((f: TreeFamily) => {
            // Keep family only if NOT all parents are hidden
            const fatherHidden = f.fatherHandle ? hiddenHandles.has(f.fatherHandle) : true;
            const motherHidden = f.motherHandle ? hiddenHandles.has(f.motherHandle) : true;
            return !(fatherHidden && motherHidden);
        });
        return computeLayout(visiblePeople, visibleFamilies);
    }, [displayData, hiddenHandles]);

    // F4: Check if a person has children (for showing toggle button)
    const hasChildren = useCallback((handle: string): boolean => {
        if (!treeData) return false;
        return treeData.families.some(f =>
            (f.fatherHandle === handle || f.motherHandle === handle) && f.children.length > 0
        );
    }, [treeData]);

    // F3: Stats computed from full layout
    const treeStats = useMemo<TreeStats | null>(() => {
        if (!layout || !treeData) return null;
        return computeTreeStats(layout.nodes, treeData.families);
    }, [layout, treeData]);

    // F2: Generation stats for headers
    const generationStats = useMemo(() => {
        if (!layout) return new Map<number, number>();
        const map = new Map<number, number>();
        for (const n of layout.nodes) {
            const gen = n.generation + 1;
            map.set(gen, (map.get(gen) ?? 0) + 1);
        }
        return map;
    }, [layout]);

    // ═══ Viewport culling: only render visible nodes ═══
    const CULL_PAD = 300; // px padding around viewport

    const visibleNodes = useMemo(() => {
        if (!layout || !viewportRef.current) return layout?.nodes ?? [];
        const vw = viewportRef.current.clientWidth;
        const vh = viewportRef.current.clientHeight;
        const { x: tx, y: ty, scale } = transform;
        // Convert viewport rect to tree-space coordinates
        const left = (-tx / scale) - CULL_PAD;
        const top = (-ty / scale) - CULL_PAD;
        const right = ((vw - tx) / scale) + CULL_PAD;
        const bottom = ((vh - ty) / scale) + CULL_PAD;
        return layout.nodes.filter(n =>
            n.x + CARD_W >= left && n.x <= right &&
            n.y + CARD_H >= top && n.y <= bottom
        );
    }, [layout, transform]);

    const visibleHandles = useMemo(() => new Set(visibleNodes.map(n => n.node.handle)), [visibleNodes]);

    // Batched SVG paths for connections
    const { parentPaths, couplePaths, visibleCouples } = useMemo(() => {
        if (!layout) return { parentPaths: '', couplePaths: '', visibleCouples: [] as PositionedCouple[] };
        let pp = '';
        let cp = '';
        const vc: PositionedCouple[] = [];
        // Only render connections where at least one endpoint is visible
        for (const c of layout.connections) {
            // Check if any endpoint is near visible area
            const vw = viewportRef.current?.clientWidth ?? 1200;
            const vh = viewportRef.current?.clientHeight ?? 900;
            const { x: tx, y: ty, scale } = transform;
            const left = (-tx / scale) - CULL_PAD;
            const top = (-ty / scale) - CULL_PAD;
            const right = ((vw - tx) / scale) + CULL_PAD;
            const bottom = ((vh - ty) / scale) + CULL_PAD;
            const inView = (x: number, y: number) =>
                x >= left && x <= right && y >= top && y <= bottom;
            if (!inView(c.fromX, c.fromY) && !inView(c.toX, c.toY)) continue;

            if (c.type === 'couple') {
                cp += `M${c.fromX},${c.fromY}L${c.toX},${c.toY}`;
            } else {
                // Each connection segment is already a single straight line
                // (either horizontal or vertical) from the layout engine
                pp += `M${c.fromX},${c.fromY}L${c.toX},${c.toY}`;
            }
        }
        // Visible couples for hearts
        for (const c of layout.couples) {
            if (visibleHandles.has(c.fatherPos?.node.handle ?? '') || visibleHandles.has(c.motherPos?.node.handle ?? '')) {
                vc.push(c);
            }
        }
        return { parentPaths: pp, couplePaths: cp, visibleCouples: vc };
    }, [layout, transform, visibleHandles]);

    // Stable callbacks for PersonCard
    const handleCardHover = useCallback((h: string | null) => setHoveredHandle(h), []);
    const handleCardClick = useCallback((handle: string, x: number, y: number) => {
        if (editorMode) {
            setSelectedCard(handle);
            setSelectedFamilyCard(null); // Giải quyết lỗi kẹt bảng Gia đình
            setDraftPerson(null);
            setDraftFamily(null);
            return;
        }
        setContextMenu({ handle, x, y });
    }, [editorMode]);
    const handleCardFocus = useCallback((handle: string) => {
        setFocusPerson(handle);
    }, []);

    // Search highlight
    useEffect(() => {
        if (!searchQuery || !treeData) { setHighlightHandles(new Set()); return; }
        const q = searchQuery.toLowerCase();
        setHighlightHandles(new Set(treeData.people.filter(p => p.displayName.toLowerCase().includes(q)).map(p => p.handle)));
    }, [searchQuery, treeData]);

    // Fit all
    const fitAll = useCallback(() => {
        if (!layout || !viewportRef.current) return;
        const vw = viewportRef.current.clientWidth;
        const vh = viewportRef.current.clientHeight;
        const pad = 40;
        const tw = layout.width + pad * 2;
        const th = layout.height + pad * 2;
        const scale = Math.max(Math.min(vw / tw, vh / th, 1.2), 0.12);
        setTransform({
            x: (vw - layout.width * scale) / 2,
            y: (vh - layout.height * scale) / 2,
            scale,
        });
    }, [layout]);

    // Auto-fit on first load
    useEffect(() => {
        if (layout && !loading) setTimeout(fitAll, 50);
    }, [layout, loading]); // eslint-disable-line

    // === Mouse handlers ===
    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        setIsDragging(true);
        dragRef.current = { startX: e.clientX, startY: e.clientY, startTx: transform.x, startTy: transform.y };
    };
    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setTransform(t => ({ ...t, x: dragRef.current.startTx + dx, y: dragRef.current.startTy + dy }));
    };
    const handleMouseUp = () => setIsDragging(false);

    // === Scroll-wheel zoom ===
    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            setTransform(t => {
                const newScale = Math.min(Math.max(t.scale * delta, 0.15), 3);
                const ratio = newScale / t.scale;
                return { scale: newScale, x: mx - (mx - t.x) * ratio, y: my - (my - t.y) * ratio };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // === Touch handlers ===
    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;

        let touching = false;
        let lastTouches: Touch[] = [];

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 1) {
                touching = true;
                const t = e.touches[0];
                dragRef.current = { startX: t.clientX, startY: t.clientY, startTx: transform.x, startTy: transform.y };
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                pinchRef.current = { initialDist: dist, initialScale: transform.scale };
            }
            lastTouches = Array.from(e.touches);
        };

        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            if (e.touches.length === 1 && touching) {
                const t = e.touches[0];
                const dx = t.clientX - dragRef.current.startX;
                const dy = t.clientY - dragRef.current.startY;
                setTransform(prev => ({ ...prev, x: dragRef.current.startTx + dx, y: dragRef.current.startTy + dy }));
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                const ratio = dist / pinchRef.current.initialDist;
                const newScale = Math.min(Math.max(pinchRef.current.initialScale * ratio, 0.15), 3);

                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                const rect = el.getBoundingClientRect();
                const mx = midX - rect.left;
                const my = midY - rect.top;

                setTransform(prev => {
                    const r = newScale / prev.scale;
                    return { scale: newScale, x: mx - (mx - prev.x) * r, y: my - (my - prev.y) * r };
                });
            }
            lastTouches = Array.from(e.touches);
        };

        const onTouchEnd = () => { touching = false; };

        el.addEventListener('touchstart', onTouchStart, { passive: false });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd);
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
        };
    }, [transform.x, transform.y, transform.scale]);

    // Pan to person
    const panToPerson = useCallback((handle: string) => {
        if (!layout || !viewportRef.current) return;
        const node = layout.nodes.find(n => n.node.handle === handle);
        if (!node) return;
        const vw = viewportRef.current.clientWidth;
        const vh = viewportRef.current.clientHeight;
        setTransform(t => ({
            ...t,
            x: vw / 2 - (node.x + CARD_W / 2) * t.scale,
            y: vh / 2 - (node.y + CARD_H / 2) * t.scale,
        }));
        setFocusPerson(handle);
    }, [layout]);

    // View mode
    const changeViewMode = (mode: ViewMode) => {
        if (mode !== 'full' && !focusPerson && treeData?.people[0]) setFocusPerson(treeData.people[0].handle);
        setViewMode(mode);
        // Auto-collapse based on view mode
        if (mode === 'full') {
            autoCollapseForPanoramic();
        } else if (mode === 'descendant') {
            const person = focusPerson || treeData?.people[0]?.handle;
            if (person) autoCollapseForDescendant(person);
        } else {
            setCollapsedBranches(new Set());
        }
    };

    // Copy shareable link
    const copyTreeLink = useCallback((handle: string) => {
        const url = `${window.location.origin}/tree?view=descendant&person=${handle}`;
        navigator.clipboard.writeText(url).then(() => {
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        });
    }, []);
    // === XỬ LÝ THÊM THÀNH VIÊN MỚI (NHÁP) ===
    const handleAddPerson = () => {
        const defaultHandle = `P${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 10)}`;
        const customHandle = window.prompt('Nhập mã ID cho Thành viên mới (Ví dụ: P020):', defaultHandle);
        
        if (!customHandle) return; // Hủy bỏ nếu người dùng bấm Cancel
        const newHandle = customHandle.trim();

        if (treeData?.people.some(p => p.handle === newHandle)) {
            alert('Mã ID này đã tồn tại! Vui lòng thử lại với mã khác.');
            return;
        }

        // Tìm gia đình cha mẹ (nếu đang chọn 1 thành viên trên cây)
        let initialGen = 1;
        let initialParentFamilies: string[] = [];
        if (selectedCard && treeData) {
            const selectedPerson = treeData.people.find(p => p.handle === selectedCard);
            if (selectedPerson) {
                initialGen = (selectedPerson.generation || 1) + 1;
                if (selectedPerson.families && selectedPerson.families.length > 0) {
                    initialParentFamilies = [selectedPerson.families[0]];
                }
            }
        }

        // TẠO BẢN NHÁP - KHÔNG LƯU NGAY XUỐNG DATABASE
        setDraftPerson({
            handle: newHandle,
            displayName: 'Thành viên mới',
            gender: 1,
            generation: initialGen,
            isLiving: true,
            isPrivacyFiltered: false,
            isPatrilineal: true,
            families: [],
            parentFamilies: initialParentFamilies,
        });
        
        // Reset các trạng thái khác để tránh kẹt giao diện
        setEditorMode(true);
        setSelectedCard(null);
        setSelectedFamilyCard(null);
        setDraftFamily(null);
    };

    // === XỬ LÝ THÊM GIA ĐÌNH MỚI (NHÁP) ===
    const handleAddFamily = () => {
        const defaultFamHandle = `F${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 10)}`;
        const customHandle = window.prompt('Nhập mã ID cho Gia đình mới (Ví dụ: F010):', defaultFamHandle);
        
        if (!customHandle) return; // Hủy bỏ nếu người dùng bấm Cancel
        const newFamHandle = customHandle.trim();

        if (treeData?.families.some(f => f.handle === newFamHandle)) {
            alert('Mã Gia đình này đã tồn tại!');
            return;
        }

        // TẠO BẢN NHÁP - KHÔNG LƯU NGAY XUỐNG DATABASE
        setDraftFamily({
            handle: newFamHandle,
            fatherHandle: undefined,
            motherHandle: undefined,
            children: []
        });
        
        // Reset các trạng thái khác để tránh kẹt giao diện
        setEditorMode(true);
        setSelectedFamilyCard(null);
        setSelectedCard(null);
        setDraftPerson(null);
    };

    // === XỬ LÝ XÓA THÀNH VIÊN ===
    const handleDeletePerson = async (handle: string) => {
        if (!confirm('Bạn có chắc chắn muốn xóa thành viên này? Hành động này không thể hoàn tác.')) {
            return;
        }

        // 1. Xóa khỏi state UI
        setTreeData(prev => {
            if (!prev) return null;
            return {
                ...prev,
                people: prev.people.filter(p => p.handle !== handle)
            };
        });
        
        setSelectedCard(null); // Đóng bảng Editor

        // 2. Xóa khỏi Database
        const { error } = await supaDeletePerson(handle);
        if (error) {
            alert('Lỗi khi xóa thành viên: ' + error);
        }
    };
    // Search results
    const searchResults = useMemo(() => {
        if (!searchQuery || !treeData) return [];
        const q = searchQuery.toLowerCase();
        return treeData.people.filter(p => p.displayName.toLowerCase().includes(q)).slice(0, 8);
    }, [searchQuery, treeData]);

    // connPath kept for compatibility but unused with batched rendering

    return (
        <div className="flex flex-col h-[calc(100vh-80px)]">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-2 px-1 pb-2">
                <div>
                    <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                        <TreePine className="h-5 w-5" /> Cây gia phả
                    </h1>
                    <p className="text-muted-foreground text-xs">
                        {layout ? `${layout.nodes.length} thành viên` : 'Đang tải...'}
                        {viewMode !== 'full' && focusPerson && (
                            <span className="ml-1 text-blue-500">
                                • {viewMode === 'ancestor' ? 'Tổ tiên' : 'Hậu duệ'} của{' '}
                                {treeData?.people.find(p => p.handle === focusPerson)?.displayName}
                            </span>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                    {/* View modes */}
                    <div className="flex rounded-lg border overflow-hidden text-xs">
                        {([['full', 'Toàn cảnh', Eye], ['ancestor', 'Tổ tiên', Users], ['descendant', 'Hậu duệ', GitBranch]] as const).map(([mode, label, Icon]) => (
                            <button key={mode} onClick={() => changeViewMode(mode)}
                                className={`px-2.5 py-1.5 font-medium flex items-center gap-1 transition-colors ${mode !== 'full' ? 'border-l' : ''} ${viewMode === mode ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
                                <Icon className="h-3.5 w-3.5" /> {label}
                            </button>
                        ))}
                    </div>
                    {/* Search */}
                    <div className="relative">
                        <div className="relative w-44">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <Input placeholder="Tìm kiếm..." value={searchQuery}
                                onChange={e => { setSearchQuery(e.target.value); setShowSearch(true); }}
                                onFocus={() => setShowSearch(true)} className="pl-8 h-8 text-xs" />
                        </div>
                        {showSearch && searchResults.length > 0 && (
                            <Card className="absolute z-50 w-56 right-0 top-10 shadow-lg">
                                <CardContent className="p-1 max-h-52 overflow-y-auto">
                                    {searchResults.map(p => (
                                        <button key={p.handle} onClick={() => {
                                            setFocusPerson(p.handle);
                                            setViewMode('descendant');
                                            autoCollapseForDescendant(p.handle);
                                            setShowSearch(false);
                                            setSearchQuery('');
                                        }}
                                            className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-accent transition-colors flex justify-between">
                                            <span className="font-medium">{p.displayName}</span>
                                            <span className="text-muted-foreground">{'generation' in p ? `Đời ${(p as any).generation}` : ''}{p.isPrivacyFiltered ? ' 🔒' : ''}</span>
                                        </button>
                                    ))}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                    {/* Controls */}
                    <div className="flex gap-0.5">
                        <Button variant="outline" size="icon" className="h-8 w-8" title="Thu gọn tất cả" onClick={collapseAll}><ChevronsDownUp className="h-3.5 w-3.5" /></Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" title="Mở rộng tất cả" onClick={expandAll}><ChevronsUpDown className="h-3.5 w-3.5" /></Button>
                        <div className="w-px bg-border mx-0.5" />
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setTransform(t => {
                            const vw = viewportRef.current?.clientWidth ?? 0; const vh = viewportRef.current?.clientHeight ?? 0;
                            const cx = vw / 2; const cy = vh / 2;
                            const ns = Math.min(t.scale * 1.3, 3); const r = ns / t.scale;
                            return { scale: ns, x: cx - (cx - t.x) * r, y: cy - (cy - t.y) * r };
                        })}><ZoomIn className="h-3.5 w-3.5" /></Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setTransform(t => {
                            const vw = viewportRef.current?.clientWidth ?? 0; const vh = viewportRef.current?.clientHeight ?? 0;
                            const cx = vw / 2; const cy = vh / 2;
                            const ns = Math.max(t.scale / 1.3, 0.15); const r = ns / t.scale;
                            return { scale: ns, x: cx - (cx - t.x) * r, y: cy - (cy - t.y) * r };
                        })}><ZoomOut className="h-3.5 w-3.5" /></Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={fitAll}><Maximize2 className="h-3.5 w-3.5" /></Button>
                        <div className="w-px bg-border mx-0.5" />
                        {isAdmin && (
                            <>
                                {/* Nút Thêm Gia đình mới */}
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-8 w-8 text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-rose-200"
                                    title="Thêm gia đình mới"
                                    onClick={handleAddFamily}
                                >
                                    <Users className="h-4 w-4" />
                                </Button>
                                {/* Nút Thêm thành viên mới */}
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-8 w-8 text-green-600 hover:bg-green-50 hover:text-green-700 border-green-200"
                                    title="Thêm thành viên mới"
                                    onClick={handleAddPerson}
                                >
                                    <UserPlus className="h-4 w-4" />
                                </Button>                               
                                {/* Nút bật/tắt chế độ chỉnh sửa (giữ nguyên) */}
                                <Button
                                    variant={editorMode ? 'default' : 'outline'}
                                    size="icon"
                                    className={`h-8 w-8 ${editorMode ? 'bg-blue-600 hover:bg-blue-700 text-white' : ''}`}
                                    title={editorMode ? 'Tắt chỉnh sửa' : 'Chế độ chỉnh sửa'}
                                    onClick={() => { setEditorMode(m => !m); setSelectedCard(null); }}
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Tree viewport + Editor panel row */}
            <div className="flex-1 flex gap-0 min-h-0">
                <div ref={viewportRef}
                    className="flex-1 relative overflow-hidden rounded-xl border-2 bg-gradient-to-br from-background to-muted/30 cursor-grab active:cursor-grabbing select-none"
                    onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                    onClick={() => { setShowSearch(false); setContextMenu(null); if (editorMode) setSelectedCard(null); }}
                >
                    {loading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
                        </div>
                    ) : layout && (
                        <div style={{
                            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                            transformOrigin: '0 0', width: layout.width, height: layout.height,
                            position: 'absolute', top: 0, left: 0,
                        }}>
                            {/* SVG connections — batched into 2 paths */}
                            <svg className="absolute inset-0 pointer-events-none" width={layout.width} height={layout.height}
                                style={{ overflow: 'visible' }}>
                                {parentPaths && <path d={parentPaths} stroke="#94a3b8" strokeWidth={1.5} fill="none" />}
                                {couplePaths && <path d={couplePaths} stroke="#cbd5e1" strokeWidth={1.5} fill="none" strokeDasharray="4,3" />}
                                {/* Couple hearts — only visible */}
                                {visibleCouples.map(c => (
                                    <text key={c.familyHandle}
                                        x={c.midX} y={c.y + CARD_H / 2 + 4}
                                        textAnchor="middle" fontSize="10" fill="#e11d48">❤</text>
                                ))}
                            </svg>

                            {/* DOM nodes — only visible (culled) */}
                            {visibleNodes.map(item => (
                                <MemoPersonCard key={item.node.handle} item={item}
                                    isHighlighted={highlightHandles.has(item.node.handle)}
                                    isFocused={focusPerson === item.node.handle}
                                    isHovered={hoveredHandle === item.node.handle}
                                    isSelected={editorMode && selectedCard === item.node.handle}
                                    zoomLevel={zoomLevel}
                                    showCollapseToggle={hasChildren(item.node.handle)}
                                    isCollapsed={collapsedBranches.has(item.node.handle)}
                                    onHover={handleCardHover}
                                    onClick={handleCardClick}
                                    onSetFocus={handleCardFocus}
                                    onToggleCollapse={toggleCollapse}
                                />
                            ))}

                            {/* F4: Branch summary cards for collapsed nodes */}
                            {Array.from(branchSummaries.entries()).map(([handle, summary]) => {
                                const parentNode = layout.nodes.find(n => n.node.handle === handle);
                                if (!parentNode) return null;
                                return (
                                    <BranchSummaryCard
                                        key={`summary-${handle}`}
                                        summary={summary}
                                        parentNode={parentNode}
                                        zoomLevel={zoomLevel}
                                        onExpand={() => toggleCollapse(handle)}
                                    />
                                );
                            })}

                            {/* Context menu on card */}
                            {contextMenu && (() => {
                                const person = treeData?.people.find(p => p.handle === contextMenu.handle);
                                if (!person) return null;
                                return (
                                    <CardContextMenu
                                        person={person}
                                        x={contextMenu.x}
                                        y={contextMenu.y}
                                        onViewDetail={() => { router.push(`/people/${person.handle}`); setContextMenu(null); }}
                                        onShowDescendants={() => { setFocusPerson(person.handle); setViewMode('descendant'); setContextMenu(null); }}
                                        onShowAncestors={() => { setFocusPerson(person.handle); setViewMode('ancestor'); setContextMenu(null); }}
                                        onSetFocus={() => { panToPerson(person.handle); setContextMenu(null); }}
                                        onShowFull={() => { setViewMode('full'); setContextMenu(null); }}
                                        onCopyLink={() => { copyTreeLink(person.handle); setContextMenu(null); }}
                                        onContribute={() => { setContributePerson({ handle: person.handle, name: person.displayName }); setContextMenu(null); }}
                                        onClose={() => setContextMenu(null)}
                                    />
                                );
                            })()}
                        </div>
                    )}

                    {/* F2: Generation Row Headers */}
                    {layout && (
                        <GenerationHeaders
                            generationStats={generationStats}
                            transform={transform}
                            cardH={CARD_H}
                        />
                    )}

                    {/* F3: Stats Overlay Panel */}
                    {treeStats && zoomLevel === 'mini' && !statsHidden && (
                        <StatsOverlay stats={treeStats} onClose={() => setStatsHidden(true)} />
                    )}

                    {/* Zoom + culling indicator */}
                    <div className="absolute bottom-2 left-2 bg-background/80 backdrop-blur border rounded px-1.5 py-0.5 text-[10px] text-muted-foreground flex gap-1.5">
                        <span>{Math.round(transform.scale * 100)}%</span>
                        {layout && <span className="opacity-60">·</span>}
                        {layout && <span>{visibleNodes.length}/{layout.nodes.length} nodes</span>}
                    </div>

                    {/* Focus person selector */}
                    {viewMode !== 'full' && treeData && (
                        <div className="absolute bottom-2 right-2 bg-background/90 backdrop-blur border rounded-lg px-2 py-1.5 flex items-center gap-1.5 text-xs">
                            <span className="text-muted-foreground">Gốc:</span>
                            <select value={focusPerson || ''} onChange={e => setFocusPerson(e.target.value)}
                                className="border rounded px-1.5 py-0.5 text-xs bg-background max-w-[140px]">
                                {treeData.people.map(p => (
                                    <option key={p.handle} value={p.handle}>{p.displayName}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Link copied toast */}
                    {linkCopied && (
                        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 z-50">
                            <Copy className="w-3.5 h-3.5" /> Đã sao chép link!
                        </div>
                    )}
                </div>

                {/* Editor Sidebar Panel */}
                {editorMode && (
                    <EditorPanel
                        selectedCard={selectedCard}
                        selectedFamilyCard={selectedFamilyCard}
                        draftPerson={draftPerson}
                        draftFamily={draftFamily}
                        treeData={treeData}
                        onDeletePerson={handleDeletePerson}
                        // THÊM ĐOẠN NÀY ĐỂ XỬ LÝ ĐỔI ID
                        onChangeHandle={async (oldHandle, newHandle) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                return {
                                    people: prev.people.map(p => p.handle === oldHandle ? { ...p, handle: newHandle } : p),
                                    families: prev.families.map(f => ({
                                        ...f,
                                        fatherHandle: f.fatherHandle === oldHandle ? newHandle : f.fatherHandle,
                                        motherHandle: f.motherHandle === oldHandle ? newHandle : f.motherHandle,
                                        children: f.children.map(ch => ch === oldHandle ? newHandle : ch)
                                    }))
                                };
                            });
                            setSelectedCard(newHandle); // Giữ panel mở trên thẻ mới

                            const { error } = await supaChangePersonHandle(oldHandle, newHandle, treeData!.families);
                            if (error) alert('Lỗi CSDL khi đổi ID: ' + error);
                        }}
                        onReorderChildren={(familyHandle, newOrder) => {
                            setTreeData(prev => prev ? {
                                ...prev,
                                families: prev.families.map(f => f.handle === familyHandle ? { ...f, children: newOrder } : f)
                            } : null);
                            supaUpdateFamilyChildren(familyHandle, newOrder);
                        }}
                        onMoveChild={(childHandle, fromFamily, toFamily) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                const families = prev.families.map(f => {
                                    if (f.handle === fromFamily) return { ...f, children: f.children.filter(c => c !== childHandle) };
                                    if (f.handle === toFamily) return { ...f, children: [...f.children, childHandle] };
                                    return f;
                                });
                                supaMoveChild(childHandle, fromFamily, toFamily, prev.families);
                                return { ...prev, families };
                            });
                        }}
                        onRemoveChild={(childHandle, familyHandle) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                const families = prev.families.map(f =>
                                    f.handle === familyHandle ? { ...f, children: f.children.filter(c => c !== childHandle) } : f
                                );
                                supaRemoveChild(childHandle, familyHandle, prev.families);
                                return { ...prev, families };
                            });
                        }}
                        onToggleLiving={(handle, isLiving) => {
                            setTreeData(prev => prev ? {
                                ...prev,
                                people: prev.people.map(p => p.handle === handle ? { ...p, isLiving } : p)
                            } : null);
                            supaUpdatePersonLiving(handle, isLiving);
                        }}
                        onUpdatePerson={(handle, fields) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                return {
                                    ...prev,
                                    people: prev.people.map(p => p.handle === handle ? { ...p, ...fields } : p)
                                };
                            });
                            supaUpdatePerson(handle, fields);
                        }}
                        // === THÊM 3 HÀM MỚI CHO GIA ĐÌNH ===
                        onChangeFamilyHandle={async (oldHandle, newHandle) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                return {
                                    people: prev.people.map(p => ({
                                        ...p,
                                        families: p.families.map(f => f === oldHandle ? newHandle : f),
                                        parentFamilies: p.parentFamilies.map(f => f === oldHandle ? newHandle : f)
                                    })),
                                    families: prev.families.map(f => f.handle === oldHandle ? { ...f, handle: newHandle } : f)
                                };
                            });
                            setSelectedFamilyCard(newHandle);
                            const { error } = await supaChangeFamilyHandle(oldHandle, newHandle, treeData!.people);
                            if (error) alert('Lỗi khi đổi ID Gia đình: ' + error);
                        }}
                        onUpdateFamilyParents={async (famHandle, oldF, newF, oldM, newM) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                // 1. Cập nhật trong bảng families
                                const newFams = prev.families.map(f => f.handle === famHandle ? { ...f, fatherHandle: newF, motherHandle: newM } : f);
                                // 2. Cập nhật mảng families của cha mẹ cũ/mới
                                const newPeople = prev.people.map(p => {
                                    let fams = [...p.families];
                                    if (p.handle === oldF || p.handle === oldM) fams = fams.filter(id => id !== famHandle);
                                    if ((p.handle === newF || p.handle === newM) && !fams.includes(famHandle)) fams.push(famHandle);
                                    return { ...p, families: fams };
                                });
                                return { families: newFams, people: newPeople };
                            });
                            await supaUpdateFamilyParents(famHandle, oldF, newF, oldM, newM, treeData!.people);
                        }}
                        onDeleteFamily={async (famHandle) => {
                            if (!confirm('Bạn có chắc chắn muốn xóa Gia đình này? Mối liên kết cha/mẹ/con của gia đình này sẽ bị ngắt.')) return;
                            setTreeData(prev => {
                                if (!prev) return null;
                                return {
                                    people: prev.people.map(p => ({
                                        ...p,
                                        families: p.families.filter(f => f !== famHandle),
                                        parentFamilies: p.parentFamilies.filter(f => f !== famHandle)
                                    })),
                                    families: prev.families.filter(f => f.handle !== famHandle)
                                };
                            });
                            setSelectedFamilyCard(null);
                            setEditorMode(false);
                            const { error } = await supaDeleteFamily(famHandle);
                            if (error) alert('Lỗi xóa Gia đình: ' + error);
                        }}
                        onReset={async () => {
                            const data = await fetchTreeData();
                            setTreeData(data);
                        }}
                        // === THÊM HÀM LƯU NHÁP THÀNH VIÊN ===
                        onSaveDraftPerson={async (person, fields) => {
                            const finalPerson = { ...person, ...fields };
                            setTreeData(prev => {
                                if (!prev) return null;
                                let updatedFams = prev.families;
                                if (finalPerson.parentFamilies.length > 0) {
                                    const targetF = finalPerson.parentFamilies[0];
                                    updatedFams = prev.families.map(f => f.handle === targetF ? { ...f, children: [...f.children, finalPerson.handle] } : f);
                                    supaUpdateFamilyChildren(targetF, [...(prev.families.find(f=>f.handle===targetF)?.children||[]), finalPerson.handle]);
                                }
                                return { ...prev, people: [...prev.people, finalPerson], families: updatedFams };
                            });
                            setDraftPerson(null);
                            setSelectedCard(finalPerson.handle);
                            await supaAddPerson(finalPerson);
                        }}

                        // === THÊM HÀM LƯU GIA ĐÌNH (MỚI & SỬA) ===
                        onSaveFamily={async (family, newFather, newMother, isDraft) => {
                            setTreeData(prev => {
                                if (!prev) return null;
                                const updatedFam = { ...family, fatherHandle: newFather, motherHandle: newMother };
                                const newFams = isDraft ? [...prev.families, updatedFam] : prev.families.map(f => f.handle === family.handle ? updatedFam : f);
                                const newPeople = prev.people.map(p => {
                                    let fams = [...p.families];
                                    if (!isDraft && (p.handle === family.fatherHandle || p.handle === family.motherHandle)) fams = fams.filter(id => id !== family.handle);
                                    if ((p.handle === newFather || p.handle === newMother) && !fams.includes(family.handle)) fams.push(family.handle);
                                    return { ...p, families: fams };
                                });
                                return { people: newPeople, families: newFams };
                            });

                            if (isDraft) {
                                setDraftFamily(null);
                                setSelectedFamilyCard(family.handle);
                                await supaAddFamily(family);
                            }
                            await supaUpdateFamilyParents(family.handle, family.fatherHandle, newFather, family.motherHandle, newMother, treeData!.people);
                        }}
                        
                        // Cập nhật onClose để xóa nháp nếu người dùng bấm dấu X hủy
                        onClose={() => { 
                            setEditorMode(false); setSelectedCard(null); setSelectedFamilyCard(null); 
                            setDraftPerson(null); setDraftFamily(null); 
                        }}
                    />
                )}
            </div>

            {/* Legend */}
            <div className="flex gap-3 text-[10px] text-muted-foreground pt-1.5 px-1 flex-wrap">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-100 border border-blue-400" /> Nam (chính tộc)</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-pink-100 border border-pink-400" /> Nữ (chính tộc)</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-slate-100 border border-dashed border-slate-300" /> Ngoại tộc</span>
                <span className="flex items-center gap-1"><span className="text-red-500">❤</span> Vợ chồng</span>
                <span className="flex items-center gap-1 opacity-60"><span className="w-2.5 h-2.5 rounded-sm bg-slate-200 border border-slate-400" /> Đã mất</span>
                <span className="ml-auto opacity-50">Cuộn để zoom • Kéo để di chuyển • Nhấn để xem</span>
            </div>
            {/* Contribute dialog */}
            {contributePerson && (
                <ContributeDialog
                    personHandle={contributePerson.handle}
                    personName={contributePerson.name}
                    onClose={() => setContributePerson(null)}
                />
            )}
        </div>
    );
}

// === Card Context Menu ===
function CardContextMenu({ person, x, y, onViewDetail, onShowDescendants, onShowAncestors, onSetFocus, onShowFull, onCopyLink, onContribute, onClose }: {
    person: TreeNode;
    x: number;
    y: number;
    onViewDetail: () => void;
    onShowDescendants: () => void;
    onShowAncestors: () => void;
    onSetFocus: () => void;
    onShowFull: () => void;
    onCopyLink: () => void;
    onContribute: () => void;
    onClose: () => void;
}) {
    return (
        <div
            className="absolute z-50 animate-in fade-in zoom-in-95 duration-150"
            style={{ left: x + 8, top: y + 8 }}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="bg-white/95 backdrop-blur-lg border border-slate-200 rounded-xl shadow-xl
                py-1.5 min-w-[200px] overflow-hidden">
                {/* Header */}
                <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
                            ${person.isPatrilineal
                                ? (person.gender === 1 ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700')
                                : 'bg-slate-100 text-slate-500'}`}>
                            {person.displayName.split(' ').map(w => w[0]).join('').slice(0, 2)}
                        </div>
                        <span className="text-sm font-semibold text-slate-800 truncate max-w-[130px]">{person.displayName}</span>
                    </div>
                    <button onClick={onClose} className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* Actions */}
                <div className="py-1">
                    <MenuAction icon={<User className="w-4 h-4" />} label="Xem chi tiết" desc="Mở trang cá nhân" onClick={onViewDetail} />
                    <MenuAction icon={<ArrowDownToLine className="w-4 h-4" />} label="Hậu duệ từ đây" desc="Hiển thị cây con cháu" onClick={onShowDescendants} />
                    <MenuAction icon={<ArrowUpFromLine className="w-4 h-4" />} label="Tổ tiên" desc="Hiển thị dòng tổ tiên" onClick={onShowAncestors} />
                    <MenuAction icon={<Crosshair className="w-4 h-4" />} label="Căn giữa" desc="Di chuyển tới vị trí" onClick={onSetFocus} />
                    <div className="border-t border-slate-100 my-1" />
                    <MenuAction icon={<Link className="w-4 h-4" />} label="Sao chép link hậu duệ" desc="Chia sẻ link cây con cháu" onClick={onCopyLink} />
                    <MenuAction icon={<Eye className="w-4 h-4" />} label="Toàn cảnh" desc="Hiển thị toàn bộ cây" onClick={onShowFull} />
                    <div className="border-t border-slate-100 my-1" />
                    <MenuAction icon={<MessageSquarePlus className="w-4 h-4" />} label="Đóng góp thông tin" desc="Bổ sung thông tin về người này" onClick={onContribute} />
                </div>
            </div>
        </div>
    );
}

function MenuAction({ icon, label, desc, onClick }: { icon: React.ReactNode; label: string; desc: string; onClick: () => void }) {
    return (
        <button
            className="w-full px-3 py-2 flex items-center gap-2.5 hover:bg-slate-50 active:bg-slate-100
                transition-colors text-left group"
            onClick={onClick}
        >
            <span className="text-slate-400 group-hover:text-blue-500 transition-colors flex-shrink-0">{icon}</span>
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-slate-700 group-hover:text-slate-900">{label}</p>
                <p className="text-[10px] text-slate-400">{desc}</p>
            </div>
        </button>
    );
}

// === Person Card Component (memoized) ===
const MemoPersonCard = memo(PersonCard, (prev, next) =>
    prev.item === next.item &&
    prev.isHighlighted === next.isHighlighted &&
    prev.isFocused === next.isFocused &&
    prev.isHovered === next.isHovered &&
    prev.isSelected === next.isSelected &&
    prev.zoomLevel === next.zoomLevel &&
    prev.showCollapseToggle === next.showCollapseToggle &&
    prev.isCollapsed === next.isCollapsed
);

function PersonCard({ item, isHighlighted, isFocused, isHovered, isSelected, zoomLevel, showCollapseToggle, isCollapsed, onHover, onClick, onSetFocus, onToggleCollapse }: {
    item: PositionedNode;
    isHighlighted: boolean;
    isFocused: boolean;
    isHovered: boolean;
    isSelected: boolean;
    zoomLevel: ZoomLevel;
    showCollapseToggle: boolean;
    isCollapsed: boolean;
    onHover: (h: string | null) => void;
    onClick: (handle: string, x: number, y: number) => void;
    onSetFocus: (handle: string) => void;
    onToggleCollapse: (handle: string) => void;
}) {
    const { node, x, y } = item;
    const isMale = node.gender === 1;
    const isFemale = node.gender === 2;
    const isDead = !node.isLiving;
    const isPatri = node.isPatrilineal;

    // ── Color system ──
    const dotColor = !isPatri ? '#94a3b8' : isMale ? '#818cf8' : isFemale ? '#f472b6' : '#94a3b8';

    // F1: MINI zoom → just a colored dot with tooltip
    if (zoomLevel === 'mini') {
        return (
            <div
                className="absolute group"
                style={{ left: x + CARD_W / 2 - 6, top: y + CARD_H / 2 - 6, width: 12, height: 12 }}
                onMouseEnter={() => onHover(node.handle)}
                onMouseLeave={() => onHover(null)}
                onClick={(e) => { e.stopPropagation(); onClick(node.handle, x + CARD_W, y + CARD_H / 2); }}
            >
                <div className="w-3 h-3 rounded-full shadow-sm" style={{ backgroundColor: dotColor }} />
                {/* Tooltip on hover */}
                <div className="hidden group-hover:block absolute -top-8 left-1/2 -translate-x-1/2 z-50
                    bg-slate-900 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap pointer-events-none">
                    {node.displayName} · Đời {item.generation + 1}
                </div>
            </div>
        );
    }

    // Extract initials
    const nameParts = node.displayName.split(' ');
    const initials = nameParts.length >= 2
        ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
        : node.displayName.slice(0, 2).toUpperCase();

    const avatarBg = !isPatri
        ? 'bg-stone-300 text-stone-600'
        : isMale
            ? (isDead ? 'bg-indigo-300 text-indigo-800' : 'bg-indigo-400 text-white')
            : isFemale
                ? (isDead ? 'bg-rose-300 text-rose-800' : 'bg-rose-400 text-white')
                : 'bg-slate-300 text-slate-600';

    const bgClass = !isPatri
        ? 'from-stone-50 to-stone-100 border-stone-300/80 border-dashed'
        : isDead
            ? (isMale
                ? 'from-indigo-50/60 to-slate-50 border-indigo-300/60'
                : 'from-rose-50/60 to-slate-50 border-rose-300/60')
            : isMale
                ? 'from-indigo-50 to-violet-50 border-indigo-300'
                : isFemale
                    ? 'from-rose-50 to-pink-50 border-rose-300'
                    : 'from-slate-50 to-slate-100 border-slate-300';

    const glowClass = isSelected ? 'ring-2 ring-blue-500 ring-offset-2 shadow-blue-200 shadow-lg'
        : isHighlighted ? 'ring-2 ring-amber-400 ring-offset-2'
            : isFocused ? 'ring-2 ring-indigo-400 ring-offset-2'
                : isHovered ? 'ring-1 ring-indigo-200' : '';

    // F1: COMPACT zoom → smaller card with just name + gen
    if (zoomLevel === 'compact') {
        return (
            <div
                className={`absolute rounded-lg border bg-gradient-to-br shadow-sm transition-all duration-200
                    cursor-pointer hover:shadow-md ${bgClass} ${glowClass}
                    ${isDead ? 'opacity-70' : ''} ${!isPatri ? 'opacity-80' : ''}`}
                style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
                onMouseEnter={() => onHover(node.handle)}
                onMouseLeave={() => onHover(null)}
                onClick={(e) => { e.stopPropagation(); onClick(node.handle, x + CARD_W, y + CARD_H / 2); }}
            >
                <div className="px-2 py-1.5 h-full flex items-center gap-2">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center
                        font-bold text-[9px] shadow-sm ring-1 ring-black/5 ${avatarBg} flex-shrink-0`}>
                        {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="font-semibold text-[10px] leading-tight text-slate-800 truncate">{node.displayName}</p>
                        <span className="text-[8px] font-semibold px-0.5 py-px rounded bg-amber-100 text-amber-700">Đời {item.generation + 1}</span>
                    </div>
                </div>
                {/* Collapse toggle */}
                {showCollapseToggle && (
                    <button
                        className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 z-10 w-5 h-5 rounded-full
                            bg-white border border-slate-300 shadow-sm flex items-center justify-center
                            hover:bg-slate-100 transition-colors"
                        onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.handle); }}
                    >
                        {isCollapsed ? <ChevronRight className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
                    </button>
                )}
            </div>
        );
    }

    // F1: FULL zoom → original detailed card
    return (
        <div
            className={`absolute rounded-xl border-[1.5px] bg-gradient-to-br shadow-sm transition-all duration-200
                cursor-pointer hover:shadow-md hover:-translate-y-0.5 ${bgClass} ${glowClass}
                ${isDead ? 'opacity-70' : ''} ${!isPatri ? 'opacity-80' : ''}`}
            style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
            onMouseEnter={() => onHover(node.handle)}
            onMouseLeave={() => onHover(null)}
            onClick={(e) => { e.stopPropagation(); onClick(node.handle, x + CARD_W, y + CARD_H / 2); }}
            onContextMenu={(e) => { e.preventDefault(); onSetFocus(node.handle); }}
        >
            <div className="px-2.5 py-2 h-full flex items-center gap-2.5">
                {/* Avatar */}
                <div className="relative flex-shrink-0">
                    <div className={`w-11 h-11 rounded-full flex items-center justify-center
                        font-bold text-sm shadow-sm ring-1 ring-black/5 ${avatarBg} ${isDead ? 'opacity-60' : ''}`}>
                        {initials}
                    </div>
                    {isPatri && (
                        <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-gradient-to-br from-teal-400 to-emerald-500
                            text-white text-[8px] flex items-center justify-center shadow-sm font-bold ring-1 ring-white">Lê</span>
                    )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                    <p className="font-semibold text-[11px] leading-tight text-slate-800 truncate">
                        {node.displayName}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                        {node.birthYear
                            ? `${node.birthYear}${node.deathYear ? ` — ${node.deathYear}` : node.isLiving ? ' — nay' : ''}`
                            : '—'}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1">
                        <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200/60">Đời {item.generation + 1}</span>
                        {isDead ? (
                            <span className="text-[9px] text-slate-400">✝ Đã mất</span>
                        ) : (
                            <span className="text-[9px] text-emerald-600 font-medium">● Còn sống</span>
                        )}
                        {!isPatri && (
                            <span className="text-[9px] text-slate-400 ml-0.5">· Ngoại tộc</span>
                        )}
                    </div>
                </div>
            </div>

            {/* F4: Collapse toggle button */}
            {showCollapseToggle && (
                <button
                    className="absolute -bottom-3 left-1/2 -translate-x-1/2 z-10 w-6 h-6 rounded-full
                        bg-white border border-slate-300 shadow-sm flex items-center justify-center
                        hover:bg-amber-50 hover:border-amber-400 transition-colors"
                    onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.handle); }}
                    title={isCollapsed ? 'Mở rộng nhánh' : 'Thu gọn nhánh'}
                >
                    {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-amber-600" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
                </button>
            )}
        </div>
    );
}

// === F4: Branch Summary Card ===
function BranchSummaryCard({ summary, parentNode, zoomLevel, onExpand }: {
    summary: BranchSummary;
    parentNode: PositionedNode;
    zoomLevel: ZoomLevel;
    onExpand: () => void;
}) {
    const x = parentNode.x;
    const y = parentNode.y + CARD_H + 40; // Position below parent with spacing

    if (zoomLevel === 'mini') {
        return (
            <div
                className="absolute group cursor-pointer"
                style={{ left: x + CARD_W / 2 - 8, top: y + CARD_H / 2 - 8, width: 16, height: 16 }}
                onClick={(e) => { e.stopPropagation(); onExpand(); }}
            >
                <div className="w-4 h-4 rounded bg-amber-400 shadow-sm flex items-center justify-center">
                    <span className="text-[7px] text-white font-bold">{summary.totalDescendants}</span>
                </div>
                <div className="hidden group-hover:block absolute -top-10 left-1/2 -translate-x-1/2 z-50
                    bg-slate-900 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap pointer-events-none">
                    📦 {summary.totalDescendants} người · Đời {summary.generationRange[0]}→{summary.generationRange[1]}
                </div>
            </div>
        );
    }

    return (
        <div
            className="absolute rounded-xl border-2 border-amber-400 bg-gradient-to-br from-amber-50 to-orange-50
                shadow-md cursor-pointer hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200"
            style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
        >
            <div className="px-2.5 py-2 h-full flex items-center gap-2.5">
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-amber-400 to-orange-500
                    flex items-center justify-center shadow-sm flex-shrink-0">
                    <Package className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="font-semibold text-[11px] leading-tight text-amber-900">
                        📦 {summary.totalDescendants} người
                    </p>
                    <p className="text-[10px] text-amber-700 mt-0.5">
                        Đời {summary.generationRange[0]} → {summary.generationRange[1]}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[9px]">
                        <span className="text-emerald-600 font-medium">● {summary.livingCount}</span>
                        <span className="text-slate-400">✝ {summary.deceasedCount}</span>
                        <span className="text-amber-600 ml-auto text-[8px] font-medium">▶ Mở</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// === F2: Generation Row Headers ===
function GenerationHeaders({ generationStats, transform, cardH }: {
    generationStats: Map<number, number>;
    transform: { x: number; y: number; scale: number };
    cardH: number;
}) {
    const V_SPACE = 80; // Must match tree-layout.ts V_SPACE
    const entries = Array.from(generationStats.entries()).sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return null;

    return (
        <div className="absolute left-0 top-0 bottom-0 overflow-hidden pointer-events-none" style={{ width: 100 }}>
            {entries.map(([gen, count]) => {
                const rowY = (gen - 1) * (cardH + V_SPACE);
                const screenY = rowY * transform.scale + transform.y;
                // Only render if in viewport
                if (screenY < -60 || screenY > 2000) return null;
                return (
                    <div
                        key={gen}
                        className="absolute left-0 flex items-center text-[10px] transition-transform duration-100"
                        style={{
                            top: screenY + (cardH * transform.scale) / 2 - 10,
                            height: 20,
                        }}
                    >
                        <div className="bg-slate-800/70 backdrop-blur text-white px-2 py-0.5 rounded-r-md
                            font-medium whitespace-nowrap shadow-sm">
                            Đ{gen} <span className="opacity-70">· {count}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// === F3: Stats Overlay Panel ===
function StatsOverlay({ stats, onClose }: { stats: TreeStats; onClose: () => void }) {
    const maxCount = Math.max(...stats.perGeneration.map(g => g.count));

    return (
        <div className="absolute top-3 right-3 w-64 bg-white/95 backdrop-blur-lg border border-slate-200
            rounded-xl shadow-xl animate-in slide-in-from-right-5 fade-in duration-300 z-40 pointer-events-auto">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
                <div className="flex items-center gap-1.5">
                    <BarChart3 className="w-4 h-4 text-indigo-500" />
                    <span className="font-semibold text-sm text-slate-800">Tổng quan</span>
                </div>
                <button onClick={onClose} className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="p-3 space-y-3">
                {/* Summary numbers */}
                <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                        <p className="text-lg font-bold text-slate-800">{stats.total}</p>
                        <p className="text-[9px] text-slate-500">Thành viên</p>
                    </div>
                    <div>
                        <p className="text-lg font-bold text-slate-800">{stats.totalGenerations}</p>
                        <p className="text-[9px] text-slate-500">Thế hệ</p>
                    </div>
                    <div>
                        <p className="text-lg font-bold text-slate-800">{stats.totalFamilies}</p>
                        <p className="text-[9px] text-slate-500">Gia đình</p>
                    </div>
                </div>

                {/* Generation distribution */}
                <div>
                    <p className="text-[10px] font-semibold text-slate-600 mb-1.5">Phân bố theo đời</p>
                    <div className="space-y-1">
                        {stats.perGeneration.map(({ gen, count }) => (
                            <div key={gen} className="flex items-center gap-1.5 text-[10px]">
                                <span className="w-6 text-right text-slate-500 font-mono">Đ{gen}</span>
                                <div className="flex-1 h-3 bg-slate-100 rounded-sm overflow-hidden">
                                    <div
                                        className="h-full bg-gradient-to-r from-indigo-400 to-violet-500 rounded-sm transition-all"
                                        style={{ width: `${(count / maxCount) * 100}%` }}
                                    />
                                </div>
                                <span className="w-6 text-slate-600 font-medium">{count}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Status breakdown */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] pt-1 border-t border-slate-100">
                    <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        <span className="text-slate-600">Còn sống</span>
                        <span className="ml-auto font-medium text-slate-800">{stats.livingCount}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-slate-300" />
                        <span className="text-slate-600">Đã mất</span>
                        <span className="ml-auto font-medium text-slate-800">{stats.deceasedCount}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-indigo-400" />
                        <span className="text-slate-600">Chính tộc</span>
                        <span className="ml-auto font-medium text-slate-800">{stats.patrilinealCount}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-stone-300" />
                        <span className="text-slate-600">Ngoại tộc</span>
                        <span className="ml-auto font-medium text-slate-800">{stats.nonPatrilinealCount}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// === Editor Panel Component ===

// ============================================================================
// COMPONENT EDITOR PANEL (ĐÃ NÂNG CẤP TÍNH ĐỜI THỨ + SỬA GIA ĐÌNH TRỰC TIẾP)
// ============================================================================
function EditorPanel({ selectedCard, selectedFamilyCard, draftPerson, draftFamily, treeData, onDeletePerson, onChangeHandle, onReorderChildren, onMoveChild, onRemoveChild, onToggleLiving, onUpdatePerson, onChangeFamilyHandle, onUpdateFamilyParents, onDeleteFamily, onSaveDraftPerson, onSaveFamily, onReset, onClose }: {
    selectedCard: string | null;
    selectedFamilyCard: string | null;
    draftPerson: TreeNode | null;
    draftFamily: TreeFamily | null;
    treeData: { people: TreeNode[]; families: TreeFamily[] } | null;
    onDeletePerson: (handle: string) => void;
    onChangeHandle: (oldHandle: string, newHandle: string) => void;
    onReorderChildren: (familyHandle: string, newOrder: string[]) => void;
    onMoveChild: (childHandle: string, fromFamily: string, toFamily: string) => void;
    onRemoveChild: (childHandle: string, familyHandle: string) => void;
    onToggleLiving: (handle: string, isLiving: boolean) => void;
    onUpdatePerson: (handle: string, fields: Record<string, unknown>) => void;
    onChangeFamilyHandle: (oldHandle: string, newHandle: string) => void;
    onUpdateFamilyParents: (famHandle: string, oldF: string | undefined, newF: string | undefined, oldM: string | undefined, newM: string | undefined) => void;
    onDeleteFamily: (famHandle: string) => void;
    onSaveDraftPerson: (person: TreeNode, fields: Record<string, unknown>) => void;
    onSaveFamily: (family: TreeFamily, father: string | undefined, mother: string | undefined, isDraft: boolean) => void;
    onReset: () => void;
    onClose: () => void;
}) {
    // ---- STATE CHO NGƯỜI (PEOPLE) ----
    const isDraftPerson = !!draftPerson;
    const person = draftPerson || (selectedCard ? treeData?.people.find(p => p.handle === selectedCard) : null);
    
    const [editName, setEditName] = useState('');
    const [editGender, setEditGender] = useState<number>(1);
    const [editGeneration, setEditGeneration] = useState<number>(1);
    const [editChi, setEditChi] = useState('');
    const [editIsPatrilineal, setEditIsPatrilineal] = useState<boolean>(true);
    const [editBirthYear, setEditBirthYear] = useState('');
    const [editDeathYear, setEditDeathYear] = useState('');
    const [editIsLiving, setEditIsLiving] = useState<boolean>(true);
    const [editParentFamily, setEditParentFamily] = useState<string>('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    
    const [parentSearch, setParentSearch] = useState('');
    const [showParentDropdown, setShowParentDropdown] = useState(false);
    const parentSearchRef = useRef<HTMLDivElement>(null);

    // ---- STATE CHO GIA ĐÌNH (FAMILIES) ----
    const isDraftFamily = !!draftFamily;
    const family = draftFamily || (selectedFamilyCard ? treeData?.families.find(f => f.handle === selectedFamilyCard) : null);
    
    const [editFamFather, setEditFamFather] = useState<string>('');
    const [editFamMother, setEditFamMother] = useState<string>('');
    const [famDirty, setFamDirty] = useState(false);

    // ---- ĐỒNG BỘ STATE KHI CHỌN CARD ----
    useEffect(() => {
        if (person) {
            setEditName(person.displayName || '');
            setEditGender(person.gender ?? 1);
            setEditGeneration(person.generation ?? 1);
            setEditChi(person.chi?.toString() || '');
            setEditIsPatrilineal(person.isPatrilineal ?? true);
            setEditBirthYear(person.birthYear?.toString() || '');
            setEditDeathYear(person.deathYear?.toString() || '');
            setEditIsLiving(person.isLiving ?? true);
            setEditParentFamily(person.parentFamilies?.[0] || '');
            setDirty(isDraftPerson);
            setParentSearch('');
            setShowParentDropdown(false);
        }
    }, [person?.handle, isDraftPerson]);

    useEffect(() => {
        if (family) {
            setEditFamFather(family.fatherHandle || '');
            setEditFamMother(family.motherHandle || '');
            setFamDirty(isDraftFamily);
        }
    }, [family?.handle, isDraftFamily]);

    // ---- HÀM LƯU DỮ LIỆU NGƯỜI ----
    const handleSavePerson = async () => {
        if (!person || !dirty) return;
        setSaving(true);
        const fields: Record<string, unknown> = {};

        if (editName !== person.displayName) fields.displayName = editName;
        if (editGender !== person.gender) fields.gender = editGender;
        if (editGeneration !== person.generation) fields.generation = editGeneration;
        const newChi = editChi ? parseInt(editChi) : null;
        if (newChi !== (person.chi ?? null)) fields.chi = newChi;
        if (editIsPatrilineal !== person.isPatrilineal) fields.isPatrilineal = editIsPatrilineal;
        if (editIsLiving !== (person.isLiving ?? true)) fields.isLiving = editIsLiving;

        const newBirth = editBirthYear ? parseInt(editBirthYear) : null;
        if (newBirth !== (person.birthYear ?? null)) fields.birthYear = newBirth;

        const newDeath = editDeathYear ? parseInt(editDeathYear) : null;
        if (newDeath !== (person.deathYear ?? null)) fields.deathYear = newDeath;

        if (isDraftPerson && editParentFamily !== (person.parentFamilies?.[0] || '')) {
            fields.parentFamilies = editParentFamily ? [editParentFamily] : [];
        }

        if (isDraftPerson) {
            onSaveDraftPerson(person, fields);
        } else if (Object.keys(fields).length > 0) {
            onUpdatePerson(person.handle, fields);
        }
        
        setDirty(false);
        setSaving(false);
    };

    if (!treeData) return null;

    // ==========================================
    // 1. GIAO DIỆN CHỈNH SỬA BẢNG GIA ĐÌNH ĐỘC LẬP
    // ==========================================
    if (family) {
        return (
            <div className="w-80 bg-background border-l flex flex-col overflow-hidden flex-shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b bg-rose-50">
                    <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-rose-600" />
                        <span className="text-sm font-semibold text-rose-800">
                            {isDraftFamily ? 'Tạo Gia đình mới' : 'Chỉnh sửa Gia đình'}
                        </span>
                    </div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-rose-100 text-rose-600"><X className="h-3.5 w-3.5" /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {/* Handle ID */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Mã định danh (handle)</label>
                        <div className="flex items-center bg-slate-50 border rounded px-2 py-1.5 text-xs text-foreground">
                            <strong className="flex-1">{family.handle}</strong>
                            {!isDraftFamily && (
                                <button type="button" className="p-1 bg-white hover:bg-rose-100 text-rose-600 rounded shadow-sm border"
                                    onClick={() => {
                                        const newId = window.prompt('Nhập mã handle mới:', family.handle);
                                        if (newId && newId.trim() !== family.handle) {
                                            if (treeData.families.some(f => f.handle === newId.trim())) alert('Mã đã tồn tại!');
                                            else onChangeFamilyHandle(family.handle, newId.trim());
                                        }
                                    }}><Pencil className="h-3 w-3" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Father / Mother */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Người Cha (father_handle)</label>
                        <select className="w-full border rounded px-2 py-1.5 text-xs bg-background"
                            value={editFamFather}
                            onChange={(e) => { setEditFamFather(e.target.value); setFamDirty(true); }}>
                            <option value="">-- Bỏ trống --</option>
                            {treeData.people.filter(p => p.gender === 1).map(p => (
                                <option key={p.handle} value={p.handle}>{p.displayName} ({p.handle})</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Người Mẹ (mother_handle)</label>
                        <select className="w-full border rounded px-2 py-1.5 text-xs bg-background"
                            value={editFamMother}
                            onChange={(e) => { setEditFamMother(e.target.value); setFamDirty(true); }}>
                            <option value="">-- Bỏ trống --</option>
                            {treeData.people.filter(p => p.gender === 2).map(p => (
                                <option key={p.handle} value={p.handle}>{p.displayName} ({p.handle})</option>
                            ))}
                        </select>
                    </div>

                    {/* Nút lưu */}
                    {famDirty && (
                        <button type="button" 
                            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-sm"
                            onClick={() => {
                                onSaveFamily(family, editFamFather || undefined, editFamMother || undefined, isDraftFamily);
                                setFamDirty(false);
                            }}>
                            <Save className="h-4 w-4" /> {isDraftFamily ? 'LƯU TẠO MỚI GIA ĐÌNH' : 'LƯU THAY ĐỔI CHA MẸ'}
                        </button>
                    )}

                    {/* Children */}
                    <div className="pt-2 border-t mt-4">
                        <label className="text-xs font-medium text-muted-foreground block mb-2">Các con (children)</label>
                        {isDraftFamily ? (
                            <div className="text-[11px] bg-blue-50 text-blue-700 p-2 rounded border border-blue-100">
                                Vui lòng bấm <strong>Lưu tạo mới gia đình</strong>. Sau đó bạn có thể thêm/xóa thành viên.
                            </div>
                        ) : (
                            <>
                                <div className="space-y-1 mb-2 max-h-40 overflow-y-auto">
                                    {family.children.length === 0 && <span className="text-[11px] text-muted-foreground italic">Mảng children đang trống</span>}
                                    {family.children.map(ch => {
                                        const childPerson = treeData.people.find(p => p.handle === ch);
                                        return (
                                            <div key={ch} className="flex justify-between items-center bg-slate-50 border p-1.5 rounded text-xs">
                                                <span className="truncate pr-2 font-medium">{childPerson?.displayName || ch}</span>
                                                <button className="text-red-500 hover:bg-red-100 p-1 rounded transition-colors" 
                                                    title="Xóa con" onClick={() => onRemoveChild(ch, family.handle)}>
                                                    <Trash2 className="h-3 w-3" />
                                                </button>
                                            </div>
                                        )
                                    })}
                                </div>
                                <select className="w-full border rounded px-2 py-1.5 text-xs bg-background text-blue-600 font-medium mt-2"
                                    value=""
                                    onChange={(e) => {
                                        if (e.target.value) {
                                            const oldFam = treeData.families.find(f => f.children.includes(e.target.value))?.handle || '';
                                            onMoveChild(e.target.value, oldFam, family.handle);
                                        }
                                    }}>
                                    <option value="">+ Thêm con (PUSH vào children)...</option>
                                    {treeData.people.filter(p => !family.children.includes(p.handle)).map(p => (
                                        <option key={p.handle} value={p.handle} className="text-foreground">{p.displayName} ({p.handle})</option>
                                    ))}
                                </select>
                            </>
                        )}
                    </div>

                    {!isDraftFamily && (
                        <div className="pt-4 mt-auto">
                            <button type="button" className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded bg-white text-red-600 border border-red-200 hover:bg-red-50 transition-colors shadow-sm"
                                onClick={() => onDeleteFamily(family.handle)}>
                                <Trash2 className="h-4 w-4" /> Xóa Gia đình này
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ==========================================
    // 2. GIAO DIỆN CHỈNH SỬA BẢNG NGƯỜI (PEOPLE)
    // ==========================================
    if (person) {
        const parentFamily = treeData.families.find(f => f.fatherHandle === person.handle || f.motherHandle === person.handle);
        const childOfFamily = treeData.families.find(f => f.children.includes(person.handle) || (isDraftPerson && person.parentFamilies.includes(f.handle)));
        
        const allParentFamilies = treeData.families.filter(f => f.fatherHandle || f.motherHandle);
        const parentFamiliesWithLabels = allParentFamilies.map(f => {
            const father = treeData.people.find(p => p.handle === f.fatherHandle);
            return { ...f, label: father ? father.displayName : f.handle, gen: father ? (father as any).generation : '' };
        });
        const filteredParentFamilies = parentSearch.trim() ? parentFamiliesWithLabels.filter(f => f.label.toLowerCase().includes(parentSearch.toLowerCase()) || f.handle.toLowerCase().includes(parentSearch.toLowerCase())) : parentFamiliesWithLabels;

        return (
            <div className="w-80 bg-background border-l flex flex-col overflow-hidden flex-shrink-0">
                <div className="flex items-center justify-between px-3 py-2 border-b bg-blue-50">
                    <div className="flex items-center gap-2">
                        <Pencil className="h-4 w-4 text-blue-600" />
                        <span className="text-sm font-semibold text-blue-800">
                            {isDraftPerson ? 'Thêm Thành viên mới' : 'Chỉnh sửa Thành viên'}
                        </span>
                    </div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-blue-100 text-blue-600"><X className="h-3.5 w-3.5" /></button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {/* Handle */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Mã định danh (handle)</label>
                        <div className="flex justify-between items-center bg-slate-50 border rounded px-2 py-1 text-xs">
                            <strong className="text-foreground">{person.handle}</strong>
                            {!isDraftPerson && (
                                <button type="button" className="p-1 bg-white hover:bg-blue-100 text-blue-600 rounded border shadow-sm"
                                    onClick={() => {
                                        const newId = window.prompt('Nhập mã handle mới:', person.handle);
                                        if (newId && newId.trim() !== person.handle) {
                                            if (treeData.people.some(p => p.handle === newId.trim())) alert('Mã đã tồn tại!');
                                            else onChangeHandle(person.handle, newId.trim());
                                        }
                                    }}><Pencil className="h-3 w-3" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Tên */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground">Họ và tên (display_name)</label>
                        <input className="w-full border rounded px-2 py-1.5 text-sm bg-background mt-0.5"
                            value={editName} onChange={e => { setEditName(e.target.value); setDirty(true); }} />
                    </div>

                    {/* Giới tính, Đời & Thứ bậc */}
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground">Giới tính</label>
                            <select className="w-full border rounded px-2 py-1.5 text-xs bg-background mt-0.5"
                                value={editGender} onChange={e => { setEditGender(Number(e.target.value)); setDirty(true); }}>
                                <option value={1}>Nam (1)</option>
                                <option value={2}>Nữ (2)</option>
                            </select>
                        </div>
                        <div className="w-16">
                            <label className="text-xs font-medium text-muted-foreground">Đời</label>
                            <input type="number" className="w-full border rounded px-2 py-1.5 text-xs bg-background mt-0.5"
                                value={editGeneration} onChange={e => { setEditGeneration(Number(e.target.value)); setDirty(true); }} />
                        </div>
                        <div className="w-16">
                            <label className="text-xs font-medium text-muted-foreground" title="Con cả (1), con thứ hai (2)...">Thứ bậc</label>
                            <input type="number" className="w-full border rounded px-2 py-1.5 text-xs bg-background mt-0.5" placeholder="-"
                                value={editChi} onChange={e => { setEditChi(e.target.value); setDirty(true); }} />
                        </div>
                    </div>

                    {/* Năm sinh / mất */}
                    <div className="flex gap-2">
                        <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground">Năm sinh (birth_year)</label>
                            <input type="number" className="w-full border rounded px-2 py-1.5 text-xs bg-background mt-0.5"
                                value={editBirthYear} onChange={e => { setEditBirthYear(e.target.value); setDirty(true); }} placeholder="—" />
                        </div>
                        <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground">Năm mất (death_year)</label>
                            <input type="number" className="w-full border rounded px-2 py-1.5 text-xs bg-background mt-0.5"
                                value={editDeathYear} onChange={e => { setEditDeathYear(e.target.value); setDirty(true); }} placeholder="—" />
                        </div>
                    </div>

                    {/* Sống / Dòng tộc */}
                    <div className="flex items-center gap-2 pt-1 border-t mt-2">
                        <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground block mb-1">Trạng thái (is_living)</label>
                            <button type="button"
                                className={`w-full text-xs px-2 py-1.5 rounded font-medium border transition-colors ${editIsLiving ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-100 border-slate-200 text-slate-500'}`}
                                onClick={() => { setEditIsLiving(!editIsLiving); setDirty(true); }}>
                                {editIsLiving ? '● Còn sống' : '○ Đã mất'}
                            </button>
                        </div>
                        <div className="flex-1">
                            <label className="text-xs font-medium text-muted-foreground block mb-1">Dòng tộc (is_patrilineal)</label>
                            <select className="w-full border rounded px-2 py-1.5 text-xs bg-background"
                                value={editIsPatrilineal ? 'true' : 'false'} onChange={e => { setEditIsPatrilineal(e.target.value === 'true'); setDirty(true); }}>
                                <option value="true">Chính tộc</option>
                                <option value="false">Ngoại tộc</option>
                            </select>
                        </div>
                    </div>

                    {/* TÍNH NĂNG 1: Tự động cập nhật Đời thứ khi chọn Cha/Mẹ lúc tạo mới */}
                    <div className="pt-2 border-t mt-2" ref={parentSearchRef}>
                        <label className="text-xs font-medium text-muted-foreground block mb-2">Làm con của gia đình (parent_families)</label>
                        {isDraftPerson ? (
                            <select className="w-full border rounded px-2 py-1.5 text-xs bg-background"
                                value={editParentFamily}
                                onChange={e => { 
                                    const newFamId = e.target.value;
                                    setEditParentFamily(newFamId); 
                                    setDirty(true); 

                                    // Auto-calculate generation (Đời cha mẹ + 1)
                                    if (newFamId && treeData) {
                                        const fam = treeData.families.find(f => f.handle === newFamId);
                                        if (fam) {
                                            const parentHandle = fam.fatherHandle || fam.motherHandle;
                                            if (parentHandle) {
                                                const parentObj = treeData.people.find(p => p.handle === parentHandle);
                                                if (parentObj && parentObj.generation) {
                                                    setEditGeneration(parentObj.generation + 1);
                                                }
                                            }
                                        }
                                    }
                                }}>
                                <option value="">-- Không có (Tổ tiên) --</option>
                                {treeData.families.map(f => (
                                    <option key={f.handle} value={f.handle}>
                                        {f.handle} (Cha: {treeData.people.find(p => p.handle === f.fatherHandle)?.displayName || '?'})
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <div className="relative">
                                <input type="text" className="w-full border rounded px-2 py-1.5 text-xs bg-background placeholder:text-muted-foreground/60"
                                    placeholder="🔍 Tìm gia đình cha mới..."
                                    value={parentSearch} onChange={e => { setParentSearch(e.target.value); setShowParentDropdown(true); }}
                                    onFocus={() => setShowParentDropdown(true)} />
                                {showParentDropdown && (
                                    <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-background border rounded shadow-lg max-h-48 overflow-y-auto">
                                        {filteredParentFamilies.map(f => (
                                            <button key={f.handle} type="button"
                                                className="w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 flex items-center gap-1 transition-colors"
                                                onClick={() => {
                                                    onMoveChild(person.handle, childOfFamily ? childOfFamily.handle : '', f.handle);
                                                    setShowParentDropdown(false);
                                                }}>
                                                <span className="truncate flex-1">{f.label} ({f.handle})</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* NÚT LƯU THÔNG TIN THÀNH VIÊN */}
                    {dirty && (
                        <button className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-sm my-2"
                            onClick={handleSavePerson} disabled={saving}>
                            <Save className="h-4 w-4" />
                            {saving ? 'ĐANG LƯU...' : (isDraftPerson ? 'LƯU THÀNH VIÊN MỚI' : 'LƯU CÁC THAY ĐỔI')}
                        </button>
                    )}

                    {/* TÍNH NĂNG 2: CHỈNH SỬA GIA ĐÌNH NGAY TRONG BẢNG NGƯỜI */}
                    <div className="pt-2 border-t mt-2">
                        <label className="text-xs font-medium text-muted-foreground block mb-2">Đã lập gia đình (families)</label>
                        {isDraftPerson ? (
                            <div className="text-[11px] bg-slate-50 text-slate-500 p-2 rounded border">
                                Vui lòng lưu thành viên trước khi chỉnh sửa gia đình.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {person.families.length === 0 && <span className="text-[11px] text-muted-foreground italic">Chưa lập gia đình</span>}
                                
                                {person.families.map(fId => {
                                    const famObj = treeData.families.find(f => f.handle === fId);
                                    if (!famObj) return null;
                                    
                                    return (
                                        <div key={fId} className="border border-blue-200 rounded bg-blue-50/40 p-2 space-y-2">
                                            {/* Tiêu đề ID Gia đình */}
                                            <div className="flex justify-between items-center border-b border-blue-100 pb-1">
                                                <span className="font-semibold text-blue-800 text-[11px] flex items-center gap-1">
                                                    <Users className="h-3 w-3" /> Gia đình: {fId}
                                                </span>
                                            </div>
                                            
                                            {/* Sửa Cha / Mẹ */}
                                            <div className="grid grid-cols-2 gap-2">
                                                <div>
                                                    <label className="text-[10px] font-medium text-muted-foreground block mb-0.5">Người Cha</label>
                                                    <select className="w-full border border-slate-200 rounded px-1 py-1 text-[11px] bg-white"
                                                        value={famObj.fatherHandle || ''}
                                                        onChange={(e) => onUpdateFamilyParents(fId, famObj.fatherHandle, e.target.value || undefined, famObj.motherHandle, famObj.motherHandle)}>
                                                        <option value="">-- Trống --</option>
                                                        {treeData.people.filter(p => p.gender === 1).map(p => (
                                                            <option key={p.handle} value={p.handle}>{p.displayName}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="text-[10px] font-medium text-muted-foreground block mb-0.5">Người Mẹ</label>
                                                    <select className="w-full border border-slate-200 rounded px-1 py-1 text-[11px] bg-white"
                                                        value={famObj.motherHandle || ''}
                                                        onChange={(e) => onUpdateFamilyParents(fId, famObj.fatherHandle, famObj.fatherHandle, famObj.motherHandle, e.target.value || undefined)}>
                                                        <option value="">-- Trống --</option>
                                                        {treeData.people.filter(p => p.gender === 2).map(p => (
                                                            <option key={p.handle} value={p.handle}>{p.displayName}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </div>

                                            {/* Sửa / Xóa Con */}
                                            <div className="pt-1">
                                                <label className="text-[10px] font-medium text-muted-foreground block mb-1">Các con ({famObj.children.length})</label>
                                                <div className="space-y-1 max-h-32 overflow-y-auto">
                                                    {famObj.children.length === 0 && <div className="text-[10px] text-muted-foreground italic">Chưa có con</div>}
                                                    {famObj.children.map(ch => {
                                                        const childPerson = treeData.people.find(p => p.handle === ch);
                                                        return (
                                                            <div key={ch} className="flex justify-between items-center bg-white border border-slate-200 p-1 rounded text-[11px] group">
                                                                <span className="truncate pr-1 font-medium">{childPerson?.displayName || ch}</span>
                                                                <button className="text-red-500 opacity-50 hover:opacity-100 hover:bg-red-50 p-0.5 rounded transition-all" 
                                                                    title="Xóa con khỏi gia đình" onClick={() => onRemoveChild(ch, fId)}>
                                                                    <Trash2 className="h-3 w-3" />
                                                                </button>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                                {/* Select Thêm Con Trực Tiếp */}
                                                <select className="w-full border border-blue-200 rounded px-1 py-1 text-[11px] bg-white text-blue-600 font-medium mt-1"
                                                    value=""
                                                    onChange={(e) => {
                                                        if (e.target.value) {
                                                            const oldFam = treeData.families.find(f => f.children.includes(e.target.value))?.handle || '';
                                                            onMoveChild(e.target.value, oldFam, fId);
                                                        }
                                                    }}>
                                                    <option value="">+ Tìm & thêm con vào GĐ này...</option>
                                                    {treeData.people.filter(p => !famObj.children.includes(p.handle)).map(p => (
                                                        <option key={p.handle} value={p.handle}>{p.displayName} ({p.handle})</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* === NÚT XÓA GIA ĐÌNH MỚI ĐƯỢC THÊM VÀO ĐÂY === */}
                                            <div className="pt-1.5 mt-1 border-t border-blue-100/50">
                                                <button type="button" 
                                                    className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold rounded bg-white text-red-600 border border-red-100 hover:bg-red-50 hover:border-red-300 transition-colors shadow-sm"
                                                    onClick={() => onDeleteFamily(fId)}>
                                                    <Trash2 className="h-3 w-3" /> Xóa Gia đình này
                                                </button>
                                            </div>

                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                    {/* Nút Xóa Thành Viên */}
                    {!isDraftPerson && (
                        <div className="pt-4 mt-auto border-t">
                            <button type="button" className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded bg-white text-red-600 border border-red-200 hover:bg-red-50 transition-colors shadow-sm"
                                onClick={() => onDeletePerson(person.handle)}>
                                <Trash2 className="h-4 w-4" /> Xóa thành viên này
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return null;
}