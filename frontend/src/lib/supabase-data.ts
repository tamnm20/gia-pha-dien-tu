/**
 * Supabase data layer for the genealogy tree
 * Replaces localStorage-based persistence with Supabase PostgreSQL
 */
import { supabase } from './supabase';
import type { TreeNode, TreeFamily } from './tree-layout';

export type { TreeNode, TreeFamily };

// ── Convert snake_case DB rows to camelCase ──

function dbRowToTreeNode(row: Record<string, unknown>): TreeNode {
    return {
        handle: row.handle as string,
        displayName: row.display_name as string,
        gender: row.gender as number,
        birthYear: row.birth_year as number | undefined,
        deathYear: row.death_year as number | undefined,
        generation: row.generation as number,
        isLiving: row.is_living as boolean,
        isPrivacyFiltered: row.is_privacy_filtered as boolean,
        isPatrilineal: row.is_patrilineal as boolean,
        families: (row.families as string[]) || [],
        parentFamilies: (row.parent_families as string[]) || [],
    };
}

function dbRowToTreeFamily(row: Record<string, unknown>): TreeFamily {
    return {
        handle: row.handle as string,
        fatherHandle: row.father_handle as string | undefined,
        motherHandle: row.mother_handle as string | undefined,
        children: (row.children as string[]) || [],
    };
}

// ── Read operations ──

/** Fetch all people from Supabase */
export async function fetchPeople(): Promise<TreeNode[]> {
    const { data, error } = await supabase
        .from('people')
        .select('handle, display_name, gender, birth_year, death_year, generation, is_living, is_privacy_filtered, is_patrilineal, families, parent_families')
        .order('generation')
        .order('handle');

    if (error) {
        console.error('Failed to fetch people:', error.message);
        return [];
    }
    return (data || []).map(dbRowToTreeNode);
}

/** Fetch all families from Supabase */
export async function fetchFamilies(): Promise<TreeFamily[]> {
    const { data, error } = await supabase
        .from('families')
        .select('handle, father_handle, mother_handle, children')
        .order('handle');

    if (error) {
        console.error('Failed to fetch families:', error.message);
        return [];
    }
    return (data || []).map(dbRowToTreeFamily);
}

/** Fetch both people and families in parallel */
export async function fetchTreeData(): Promise<{ people: TreeNode[]; families: TreeFamily[] }> {
    const [people, families] = await Promise.all([fetchPeople(), fetchFamilies()]);
    return { people, families };
}

// ── Write operations (editor mode) ──

/** Update children order for a family */
export async function updateFamilyChildren(
    familyHandle: string,
    newChildrenOrder: string[]
): Promise<void> {
    const { error } = await supabase
        .from('families')
        .update({ children: newChildrenOrder })
        .eq('handle', familyHandle);

    if (error) console.error('Failed to update family children:', error.message);
}

/** Move a child from one family to another */
export async function moveChildToFamily(
    childHandle: string,
    fromFamilyHandle: string,
    toFamilyHandle: string,
    currentFamilies: TreeFamily[]
): Promise<void> {
    const fromFam = currentFamilies.find(f => f.handle === fromFamilyHandle);
    const toFam = currentFamilies.find(f => f.handle === toFamilyHandle);

    const updates: Promise<unknown>[] = [];

    // Update families.children on both families
    if (fromFam) {
        updates.push(
            updateFamilyChildren(fromFamilyHandle, fromFam.children.filter(ch => ch !== childHandle))
        );
    }
    if (toFam) {
        updates.push(
            updateFamilyChildren(toFamilyHandle, [...toFam.children.filter(ch => ch !== childHandle), childHandle])
        );
    }

    // Update people.parent_families on the child
    const { data: personData } = await supabase
        .from('people')
        .select('parent_families')
        .eq('handle', childHandle)
        .single();

    if (personData) {
        const currentPF = (personData.parent_families as string[]) || [];
        const newPF = [...currentPF.filter(pf => pf !== fromFamilyHandle), toFamilyHandle];
        updates.push(
            (async () => { await supabase.from('people').update({ parent_families: newPF, updated_at: new Date().toISOString() }).eq('handle', childHandle); })()
        );
    }

    await Promise.all(updates);
}

/** Remove a child from a family */
export async function removeChildFromFamily(
    childHandle: string,
    familyHandle: string,
    currentFamilies: TreeFamily[]
): Promise<void> {
    const fam = currentFamilies.find(f => f.handle === familyHandle);
    const updates: Promise<unknown>[] = [];

    if (fam) {
        updates.push(
            updateFamilyChildren(familyHandle, fam.children.filter(ch => ch !== childHandle))
        );
    }

    // Also update people.parent_families on the child
    const { data: personData } = await supabase
        .from('people')
        .select('parent_families')
        .eq('handle', childHandle)
        .single();

    if (personData) {
        const currentPF = (personData.parent_families as string[]) || [];
        const newPF = currentPF.filter(pf => pf !== familyHandle);
        updates.push(
            (async () => { await supabase.from('people').update({ parent_families: newPF, updated_at: new Date().toISOString() }).eq('handle', childHandle); })()
        );
    }

    await Promise.all(updates);
}

/** Update a person's isLiving status */
export async function updatePersonLiving(
    handle: string,
    isLiving: boolean
): Promise<void> {
    const { error } = await supabase
        .from('people')
        .update({ is_living: isLiving })
        .eq('handle', handle);

    if (error) console.error('Failed to update person living status:', error.message);
}

/** Update a person's editable fields */
export async function updatePerson(
    handle: string,
    fields: {
        displayName?: string;
        birthYear?: number | null;
        deathYear?: number | null;
        isLiving?: boolean;
        gender?: number;
        generation?: number;
        isPatrilineal?: boolean;
        phone?: string | null;
        email?: string | null;
        currentAddress?: string | null;
        hometown?: string | null;
        occupation?: string | null;
        education?: string | null;
        notes?: string | null;
    }
): Promise<void> {
    // Convert camelCase → snake_case cho DB
    const dbFields: Record<string, unknown> = {};
    if (fields.displayName !== undefined) dbFields.display_name = fields.displayName;
    if (fields.birthYear !== undefined) dbFields.birth_year = fields.birthYear;
    if (fields.deathYear !== undefined) dbFields.death_year = fields.deathYear;
    if (fields.isLiving !== undefined) dbFields.is_living = fields.isLiving;
    if (fields.gender !== undefined) dbFields.gender = fields.gender;
    if (fields.generation !== undefined) dbFields.generation = fields.generation;
    if (fields.isPatrilineal !== undefined) dbFields.is_patrilineal = fields.isPatrilineal;
    if (fields.phone !== undefined) dbFields.phone = fields.phone;
    if (fields.email !== undefined) dbFields.email = fields.email;
    if (fields.currentAddress !== undefined) dbFields.current_address = fields.currentAddress;
    if (fields.hometown !== undefined) dbFields.hometown = fields.hometown;
    if (fields.occupation !== undefined) dbFields.occupation = fields.occupation;
    if (fields.education !== undefined) dbFields.education = fields.education;
    if (fields.notes !== undefined) dbFields.notes = fields.notes;
    dbFields.updated_at = new Date().toISOString();

    const { error } = await supabase
        .from('people')
        .update(dbFields)
        .eq('handle', handle);

    if (error) console.error('Failed to update person:', error.message);
}

/** Add a new person to the tree */
export async function addPerson(person: {
    handle: string;
    displayName: string;
    gender: number;
    generation: number;
    birthYear?: number | null;
    deathYear?: number | null;
    isLiving?: boolean;
    families?: string[];
    parentFamilies?: string[];
}): Promise<{ error: string | null }> {
    const { error } = await supabase
        .from('people')
        .insert({
            handle: person.handle,
            display_name: person.displayName,
            gender: person.gender,
            generation: person.generation,
            birth_year: person.birthYear || null,
            death_year: person.deathYear || null,
            is_living: person.isLiving ?? true,
            is_privacy_filtered: false,
            is_patrilineal: person.gender === 1,
            families: person.families || [],
            parent_families: person.parentFamilies || [],
        });

    if (error) {
        console.error('Failed to add person:', error.message);
        return { error: error.message };
    }
    return { error: null };
}

/** Delete a person from the tree */
export async function deletePerson(handle: string): Promise<{ error: string | null }> {
    const { error } = await supabase
        .from('people')
        .delete()
        .eq('handle', handle);

    if (error) {
        console.error('Failed to delete person:', error.message);
        return { error: error.message };
    }
    return { error: null };
}

/** Add a new family */
export async function addFamily(family: {
    handle: string;
    fatherHandle?: string;
    motherHandle?: string;
    children?: string[];
}): Promise<{ error: string | null }> {
    const { error } = await supabase
        .from('families')
        .insert({
            handle: family.handle,
            father_handle: family.fatherHandle || null,
            mother_handle: family.motherHandle || null,
            children: family.children || [],
        });

    if (error) {
        console.error('Failed to add family:', error.message);
        return { error: error.message };
    }
    return { error: null };
}

/** * Đổi mã Handle của một người 
 * (Cập nhật cả bảng people và các liên kết trong bảng families) 
 */
export async function changePersonHandle(
    oldHandle: string,
    newHandle: string,
    currentFamilies: TreeFamily[]
): Promise<{ error: string | null }> {
    // 1. Đổi ID trong bảng people
    const { error: err1 } = await supabase
        .from('people')
        .update({ handle: newHandle })
        .eq('handle', oldHandle);

    if (err1) {
        console.error('Lỗi khi đổi ID người:', err1.message);
        return { error: err1.message };
    }

    // 2. Cập nhật ID mới nếu người này đang là cha hoặc mẹ
    await supabase.from('families').update({ father_handle: newHandle }).eq('father_handle', oldHandle);
    await supabase.from('families').update({ mother_handle: newHandle }).eq('mother_handle', oldHandle);

    // 3. Cập nhật ID mới trong mảng children của các gia đình có chứa người này
    const familiesWithChild = currentFamilies.filter(f => f.children.includes(oldHandle));
    for (const fam of familiesWithChild) {
        const newChildren = fam.children.map(ch => ch === oldHandle ? newHandle : ch);
        await supabase.from('families').update({ children: newChildren }).eq('handle', fam.handle);
    }

    return { error: null };
}

/** Đổi mã Handle của một Gia đình */
export async function changeFamilyHandle(oldHandle: string, newHandle: string, currentPeople: TreeNode[]): Promise<{ error: string | null }> {
    const { error: err1 } = await supabase.from('families').update({ handle: newHandle }).eq('handle', oldHandle);
    if (err1) return { error: err1.message };

    // Cập nhật lại mảng families và parent_families của tất cả thành viên liên quan
    for (const p of currentPeople) {
        let updated = false;
        let newFams = p.families;
        let newParentFams = p.parentFamilies;

        if (newFams.includes(oldHandle)) { newFams = newFams.map(f => f === oldHandle ? newHandle : f); updated = true; }
        if (newParentFams.includes(oldHandle)) { newParentFams = newParentFams.map(f => f === oldHandle ? newHandle : f); updated = true; }

        if (updated) await supabase.from('people').update({ families: newFams, parent_families: newParentFams }).eq('handle', p.handle);
    }
    return { error: null };
}

/** Cập nhật Cha/Mẹ cho Gia đình */
export async function updateFamilyParents(
    familyHandle: string, oldFather: string | undefined, newFather: string | undefined, 
    oldMother: string | undefined, newMother: string | undefined, currentPeople: TreeNode[]
) {
    await supabase.from('families').update({ father_handle: newFather || null, mother_handle: newMother || null }).eq('handle', familyHandle);
    const updates: Promise<any>[] = [];
    
    // Cập nhật mảng families cho Cha cũ & mới
    if (oldFather && oldFather !== newFather) {
        const p = currentPeople.find(x => x.handle === oldFather);
        if (p) updates.push(supabase.from('people').update({ families: p.families.filter(f => f !== familyHandle) }).eq('handle', oldFather));
    }
    if (newFather && oldFather !== newFather) {
        const p = currentPeople.find(x => x.handle === newFather);
        if (p && !p.families.includes(familyHandle)) updates.push(supabase.from('people').update({ families: [...p.families, familyHandle] }).eq('handle', newFather));
    }
    // Cập nhật mảng families cho Mẹ cũ & mới
    if (oldMother && oldMother !== newMother) {
        const p = currentPeople.find(x => x.handle === oldMother);
        if (p) updates.push(supabase.from('people').update({ families: p.families.filter(f => f !== familyHandle) }).eq('handle', oldMother));
    }
    if (newMother && oldMother !== newMother) {
        const p = currentPeople.find(x => x.handle === newMother);
        if (p && !p.families.includes(familyHandle)) updates.push(supabase.from('people').update({ families: [...p.families, familyHandle] }).eq('handle', newMother));
    }
    await Promise.all(updates);
}

/** Xóa Gia đình */
export async function deleteFamily(handle: string): Promise<{ error: string | null }> {
    const { error } = await supabase.from('families').delete().eq('handle', handle);
    return { error: error ? error.message : null };
}
