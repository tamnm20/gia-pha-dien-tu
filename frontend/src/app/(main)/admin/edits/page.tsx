'use client';

import { useEffect, useState, useCallback } from 'react';
import { Check, X, Clock, MessageSquarePlus, ChevronDown, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/components/auth-provider';
import { useRouter } from 'next/navigation';

interface Contribution {
    id: string;
    author_id: string;
    author_email: string;
    person_handle: string;
    person_name: string;
    field_name: string;
    field_label: string;
    old_value: string | null;
    new_value: string;
    note: string | null;
    status: 'pending' | 'approved' | 'rejected';
    admin_note: string | null;
    created_at: string;
    reviewed_at: string | null;
}

export default function AdminEditsPage() {
    const { isAdmin, loading: authLoading, user } = useAuth();
    const router = useRouter();
    const [contributions, setContributions] = useState<Contribution[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('pending');
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});

    const fetchContributions = useCallback(async () => {
        setLoading(true);
        let query = supabase.from('contributions').select('*').order('created_at', { ascending: false });
        if (filter !== 'all') query = query.eq('status', filter);
        const { data } = await query;
        setContributions((data as Contribution[]) || []);
        setLoading(false);
    }, [filter]);

    useEffect(() => {
        if (!authLoading && !isAdmin) {
            router.push('/tree');
            return;
        }
        if (!authLoading && isAdmin) fetchContributions();
    }, [authLoading, isAdmin, fetchContributions, router]);

    // HÀM XỬ LÝ DUYỆT / TỪ CHỐI ĐÓNG GÓP
    const handleAction = async (id: string, action: 'approved' | 'rejected') => {
        setProcessingId(id);
        const adminNote = adminNotes[id] || null;
        
        // Tìm thông tin của bản ghi đóng góp đang thao tác
        const contribution = contributions.find(c => c.id === id);

        if (!contribution) {
            setProcessingId(null);
            return;
        }

        // 1. NẾU BẤM DUYỆT -> CẬP NHẬT TRỰC TIẾP VÀO BẢNG `people`
        if (action === 'approved') {
            const targetHandle = contribution.person_handle;
            let fieldName = contribution.field_name;
            const rawValue = contribution.new_value;

            if (!targetHandle || !fieldName || rawValue === undefined || rawValue === null) {
                alert('Lỗi: Bản ghi đóng góp bị thiếu person_handle hoặc field_name!');
                setProcessingId(null);
                return;
            }

            // Map lại tên cột nếu form khác DB (ví dụ form gửi 'address' nhưng DB là 'current_address')
            if (fieldName === 'address') fieldName = 'current_address';

            // Ép kiểu số cho các trường dạng số nguyên
            const isNumericField = ['birth_year', 'death_year', 'generation', 'gender', 'chi'].includes(fieldName);
            const finalValue = isNumericField ? parseInt(rawValue, 10) : rawValue.trim();

            // Thực hiện UPDATE vào bảng people
            const { error: peopleError } = await supabase
                .from('people')
                .update({ [fieldName]: finalValue })
                .eq('handle', targetHandle);

            if (peopleError) {
                console.error('Lỗi update bảng people:', peopleError);
                alert(`Lỗi CSDL khi ghi vào bảng people: ${peopleError.message}`);
                setProcessingId(null);
                return; // Nếu lỗi bảng people thì dừng lại, không chuyển trạng thái thành approved
            }
        }

        // 2. CẬP NHẬT TRẠNG THÁI VÀO BẢNG `contributions`
        const { error: contributionError } = await supabase
            .from('contributions')
            .update({
                status: action,
                admin_note: adminNote,
                reviewed_by: user?.id,
                reviewed_at: new Date().toISOString(),
            })
            .eq('id', id);

        if (contributionError) {
            console.error('Lỗi update trạng thái contributions:', contributionError);
            alert(`Lỗi cập nhật bảng đóng góp: ${contributionError.message}`);
        } else {
            alert(action === 'approved' 
                ? `✅ Đã duyệt và lưu thành công "${contribution.field_label}: ${contribution.new_value}" vào hồ sơ!` 
                : 'Đã từ chối đóng góp.');
        }

        setProcessingId(null);
        fetchContributions();
    };

    const statusColors = {
        pending: 'bg-amber-100 text-amber-700 border-amber-200',
        approved: 'bg-green-100 text-green-700 border-green-200',
        rejected: 'bg-red-100 text-red-700 border-red-200',
    };

    const statusLabels = {
        pending: 'Chờ duyệt',
        approved: 'Đã duyệt',
        rejected: 'Từ chối',
    };

    const pendingCount = contributions.filter(c => c.status === 'pending').length;

    if (authLoading) return <div className="flex items-center justify-center h-96"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;

    return (
        <div className="max-w-4xl mx-auto p-4 space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold flex items-center gap-2">
                        <MessageSquarePlus className="h-5 w-5" /> Đóng góp từ thành viên
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {pendingCount > 0 ? `${pendingCount} đóng góp chờ duyệt` : 'Không có đóng góp nào chờ duyệt'}
                    </p>
                </div>
                <div className="flex items-center gap-1 border rounded-lg overflow-hidden text-xs">
                    {(['pending', 'approved', 'rejected', 'all'] as const).map(f => (
                        <button key={f} onClick={() => setFilter(f)}
                            className={`px-3 py-1.5 font-medium transition-colors ${filter === f ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
                            {f === 'all' ? 'Tất cả' : statusLabels[f]}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center h-48">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                </div>
            ) : contributions.length === 0 ? (
                <Card>
                    <CardContent className="flex items-center justify-center h-48 text-muted-foreground">
                        <p className="text-sm">Không có đóng góp nào {filter !== 'all' ? `(${statusLabels[filter]})` : ''}</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {contributions.map(c => (
                        <Card key={c.id} className={`transition-all ${c.status === 'pending' ? 'border-amber-300 shadow-sm' : ''}`}>
                            <CardContent className="p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0 space-y-2">
                                        {/* Header */}
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${statusColors[c.status]}`}>
                                                {statusLabels[c.status]}
                                            </span>
                                            <span className="text-xs font-semibold">{c.person_name || c.person_handle}</span>
                                            <span className="text-xs text-muted-foreground">→ {c.field_label || c.field_name}</span>
                                        </div>

                                        {/* Value */}
                                        <div className="bg-muted/50 rounded-lg p-3">
                                            <p className="text-xs font-medium text-muted-foreground mb-1">Giá trị mới:</p>
                                            <p className="text-sm font-medium">{c.new_value}</p>
                                            {c.note && (
                                                <p className="text-xs text-muted-foreground mt-2 italic">📝 {c.note}</p>
                                            )}
                                        </div>

                                        {/* Meta */}
                                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                                            <span>Từ: {c.author_email}</span>
                                            <span>•</span>
                                            <span>{new Date(c.created_at).toLocaleString('vi-VN')}</span>
                                        </div>

                                        {/* Admin note */}
                                        {c.admin_note && (
                                            <p className="text-xs bg-blue-50 dark:bg-blue-950/30 rounded p-2 text-blue-700 dark:text-blue-400">
                                                💬 Admin: {c.admin_note}
                                            </p>
                                        )}
                                    </div>

                                    {/* Actions for pending */}
                                    {c.status === 'pending' && (
                                        <div className="flex flex-col gap-1.5 flex-shrink-0">
                                            <Input
                                                placeholder="Ghi chú..."
                                                className="text-xs h-7 w-32"
                                                value={adminNotes[c.id] || ''}
                                                onChange={e => setAdminNotes(prev => ({ ...prev, [c.id]: e.target.value }))}
                                            />
                                            <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
                                                disabled={processingId === c.id}
                                                onClick={() => handleAction(c.id, 'approved')}>
                                                <Check className="w-3 h-3 mr-1" /> Duyệt
                                            </Button>
                                            <Button size="sm" variant="outline" className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                                                disabled={processingId === c.id}
                                                onClick={() => handleAction(c.id, 'rejected')}>
                                                <X className="w-3 h-3 mr-1" /> Từ chối
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}