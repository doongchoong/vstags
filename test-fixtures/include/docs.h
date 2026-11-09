#ifndef DOCS_H
#define DOCS_H

/* 최대 부서명 길이 */
#define MAX_DNAME 20   /* (옆 주석) */

/* 이건 관계없는 주석 */

/********************************
 * 부서 정보
 *   본부/팀 단위
 ********************************/
typedef struct dept_info {
    int    no;               /* 부서번호 */
    char   dname[MAX_DNAME]; // 부서명
    int    lo; int hi;       /* 범위 상한 */
} DeptInfo;

// 부서 조회
// no: 부서번호
static int
find_dept(int no, DeptInfo *out);

#endif
