# no_follow.pl <op> <file> [command...]: the hand-off's file work on a home a confined runtime can write. bash cannot open
# without following a link, so a `>> "$LOG"` there lets the runtime aim this unconfined process at any file of the user, or
# hang it on a FIFO. Mirror of apps/desktop/electron/lib/no-follow-fs.ts. Exit 3 = refused.
#   append         stdin to the end of <file>
#   read           <file> to stdout
#   replace        stdin to a new temp beside <file>, then rename onto it (a link at <file> is replaced, not followed)
#   publish-new    same, but link(2): exit 1 when <file> already exists, never replaces
#   chmod-private  fchmod 0600 on the open file; exit 3 for a link, a special file or a hard link, which stay as they are
#   exec-log       runs the command with stdout and stderr appended to <file>; refused = /dev/null, the work still runs
#   exec-err-log   same for stderr only
use strict;
use warnings;
use Fcntl qw(:DEFAULT :mode);

# <sys/fcntl.h> on macOS 11+, every component of the path. The kernel answers EINVAL to it combined with O_NOFOLLOW.
my $NEVER_FOLLOW = $^O eq 'darwin' ? 0x20000000 : O_NOFOLLOW;
my $REFUSED = 3;

sub open_plain {
    my ($path, $flags) = @_;
    sysopen(my $fh, $path, $flags | $NEVER_FOLLOW | O_NONBLOCK, 0600) or return;
    my @st = stat($fh);
    unless (@st && S_ISREG($st[2]) && $st[3] <= 1) {
        close $fh;
        return;
    }
    binmode $fh;
    return $fh;
}

sub write_all {
    my ($fh, $bytes) = @_;
    my $at = 0;
    while ($at < length $bytes) {
        my $n = syswrite($fh, $bytes, length($bytes) - $at, $at);
        return 0 unless defined $n;
        $at += $n;
    }
    return 1;
}

sub stdin_bytes { local $/; binmode STDIN; my $bytes = <STDIN>; return defined $bytes ? $bytes : ''; }

sub stage_temp {
    my ($file) = @_;
    my $temp = "$file.$$." . int(rand(1 << 30)) . '.tmp';
    my $fh = open_plain($temp, O_WRONLY | O_CREAT | O_EXCL) or exit $REFUSED;
    my $ok = write_all($fh, stdin_bytes());
    close $fh;
    unless ($ok) { unlink $temp; exit 1; }
    return $temp;
}

sub exec_with_log {
    my ($file, $also_stdout, @command) = @_;
    my $log = open_plain($file, O_WRONLY | O_CREAT | O_APPEND);
    unless ($log) { open($log, '>>', '/dev/null') or exit 1; }
    open(STDERR, '>&', $log) or exit 1;
    if ($also_stdout) { open(STDOUT, '>&', $log) or exit 1; }
    close $log;
    exec { $command[0] } @command or exit 127;
}

my ($op, $file, @rest) = @ARGV;
defined $file or exit 64;

if ($op eq 'append') {
    my $fh = open_plain($file, O_WRONLY | O_CREAT | O_APPEND) or exit $REFUSED;
    exit(write_all($fh, stdin_bytes()) ? 0 : 1);
}
if ($op eq 'read') {
    my $fh = open_plain($file, O_RDONLY) or exit($!{ENOENT} ? 1 : $REFUSED);
    binmode STDOUT;
    my $chunk;
    print $chunk while sysread($fh, $chunk, 65536);
    exit 0;
}
if ($op eq 'replace') {
    my $temp = stage_temp($file);
    my $ok = rename($temp, $file);
    unlink $temp unless $ok;
    exit($ok ? 0 : 1);
}
if ($op eq 'publish-new') {
    my $temp = stage_temp($file);
    my $ok = link($temp, $file);
    unlink $temp;
    exit($ok ? 0 : 1);
}
if ($op eq 'chmod-private') {
    my $fh = open_plain($file, O_RDONLY) or exit($!{ENOENT} ? 1 : $REFUSED);
    exit(chmod(0600, $fh) ? 0 : 1);
}
exec_with_log($file, 1, @rest) if $op eq 'exec-log';
exec_with_log($file, 0, @rest) if $op eq 'exec-err-log';
exit 64;
